/**
 * Extract structured context from inquiry conversations.
 *
 * Reads ml_support_inquiries, sends each unprocessed conversation to
 * OpenAI to extract publication IDs, advisor statements, and classifications.
 * Saves results to publication_history.
 *
 * Cost: ~$0.001 per conversation (gpt-4o-mini)
 * Run after scrape-all.js
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

function log(level, action, data = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, action, ...data }));
}

async function supabaseGet(path) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
  });
  return resp.json();
}

async function supabasePost(table, data) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json', 'Prefer': 'return=minimal',
    },
    body: JSON.stringify(data),
  });
  return resp.ok;
}

async function extractWithLLM(conversation, inquiryNumber, country) {
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.1,
      max_tokens: 800,
      messages: [
        {
          role: 'system',
          content: `Extraes hechos clave de conversaciones de soporte de MercadoLibre. Responde SOLO en JSON valido, sin texto extra. Formato:
{
  "publications": [
    {
      "ml_item_id": "MCO1234567",
      "advisor_said": "texto corto de lo que dijo el asesor sobre esta publicacion",
      "reason": "sustancia_prohibida|falso_positivo|error_sistema|marca|politica|otro",
      "substance": "melatonina (si aplica, sino null)",
      "result": "aceptado|rechazado|pendiente|sin_respuesta",
      "advisor_name": "nombre del asesor (si se menciona, sino null)"
    }
  ],
  "general_context": "resumen de 1 linea de la conversacion",
  "suspension_mentioned": true/false,
  "technical_error_mentioned": true/false
}
Si no hay publicaciones mencionadas, devuelve publications vacio.`
        },
        {
          role: 'user',
          content: `Inquiry #${inquiryNumber} (${country}):\n\n${conversation.substring(0, 6000)}`
        },
      ],
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`OpenAI error: ${resp.status} ${err.substring(0, 200)}`);
  }

  const data = await resp.json();
  const text = data.choices[0].message.content.trim();

  // Parse JSON from response
  try {
    // Handle markdown code blocks
    const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(jsonStr);
  } catch (e) {
    log('warn', 'json_parse_failed', { inquiry: inquiryNumber, raw: text.substring(0, 200) });
    return null;
  }
}

(async () => {
  log('info', 'extract_start');

  if (!OPENAI_KEY) {
    log('error', 'no_openai_key');
    process.exit(1);
  }

  // Get inquiries with conversations
  const inquiries = await supabaseGet(
    'ml_support_inquiries?select=inquiry_number,country,store_id,conversation_text,inquiry_status&conversation_text=not.is.null&order=inquiry_date.desc'
  );

  // Get already processed inquiries (check publication_history for source_ref)
  const processed = await supabaseGet(
    'publication_history?select=source_ref&source=eq.inquiry_extraction'
  );
  const processedRefs = new Set((processed || []).map(p => p.source_ref));

  const toProcess = (inquiries || []).filter(inq =>
    inq.conversation_text &&
    inq.conversation_text.length > 50 &&
    !processedRefs.has(`inquiry:${inq.inquiry_number}`)
  );

  log('info', 'inquiries_found', {
    total: (inquiries || []).length,
    with_conversation: toProcess.length + processedRefs.size,
    already_processed: processedRefs.size,
    to_process: toProcess.length
  });

  let extracted = 0;
  let events_created = 0;
  let errors = 0;

  for (const inq of toProcess) {
    try {
      log('info', 'processing', { inquiry: inq.inquiry_number, country: inq.country });

      const result = await extractWithLLM(inq.conversation_text, inq.inquiry_number, inq.country);
      if (!result) { errors++; continue; }

      // Save events for each publication mentioned
      for (const pub of (result.publications || [])) {
        if (!pub.ml_item_id) continue;

        // Advisor statement
        if (pub.advisor_said) {
          await supabasePost('publication_history', {
            ml_item_id: pub.ml_item_id,
            store_id: inq.store_id,
            country: inq.country,
            event_type: 'asesor_ml_dijo',
            source: 'inquiry_extraction',
            source_ref: `inquiry:${inq.inquiry_number}`,
            content: pub.advisor_said,
            metadata: {
              inquiry_number: inq.inquiry_number,
              advisor_name: pub.advisor_name,
              reason: pub.reason,
              substance: pub.substance,
              result: pub.result,
            },
          });
          events_created++;
        }

        // Classification
        if (pub.reason) {
          await supabasePost('publication_history', {
            ml_item_id: pub.ml_item_id,
            store_id: inq.store_id,
            country: inq.country,
            event_type: 'clasificacion',
            source: 'inquiry_extraction',
            source_ref: `inquiry:${inq.inquiry_number}`,
            content: `${pub.reason}${pub.substance ? ': ' + pub.substance : ''}`,
            metadata: {
              reason: pub.reason,
              substance: pub.substance,
              result: pub.result,
            },
          });
          events_created++;
        }
      }

      // Save general context
      if (result.general_context) {
        await supabasePost('publication_history', {
          ml_item_id: `inquiry:${inq.inquiry_number}`,
          store_id: inq.store_id,
          country: inq.country,
          event_type: 'contexto_general',
          source: 'inquiry_extraction',
          source_ref: `inquiry:${inq.inquiry_number}`,
          content: result.general_context,
          metadata: {
            suspension_mentioned: result.suspension_mentioned,
            technical_error_mentioned: result.technical_error_mentioned,
            inquiry_status: inq.inquiry_status,
          },
        });
        events_created++;
      }

      extracted++;
      log('info', 'extracted', {
        inquiry: inq.inquiry_number,
        publications: (result.publications || []).length,
        events: events_created,
      });

      // Rate limit
      await new Promise(r => setTimeout(r, 500));

    } catch (e) {
      errors++;
      log('error', 'extraction_failed', { inquiry: inq.inquiry_number, error: e.message.split('\n')[0] });
    }
  }

  log('info', 'extract_done', {
    processed: extracted,
    events_created,
    errors,
    cost_estimate: `$${(extracted * 0.001).toFixed(3)}`,
  });
})().catch(e => { log('error', 'fatal', { error: e.message }); process.exit(1); });
