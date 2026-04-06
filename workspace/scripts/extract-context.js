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
      max_tokens: 1500,
      messages: [
        {
          role: 'system',
          content: `Extraes hechos clave de conversaciones de soporte de MercadoLibre. Responde SOLO en JSON valido, sin texto extra. Formato:
{
  "classification": "apelacion|validacion_preventiva|suspension|reclamo|exclusion_demoras|operativo|error_operativo|consulta_general",
  "advisor_dropux": "nombre del asesor de Dropux que abre el caso (quien escribe, no el de ML)",
  "advisor_ml": "nombre del asesor de MercadoLibre que responde",
  "result": "resuelto|rechazado|pendiente|sin_resultado|informativo",
  "quality_score": "bueno|regular|malo",
  "quality_reason": "explicacion corta de por que esa calificacion",
  "inquiry_channel": "chat|formulario",
  "general_context": "resumen de 2-3 lineas de lo que se pidio y que respondio ML",
  "publications": [
    {
      "ml_item_id": "MCO1234567",
      "advisor_said": "texto corto de lo que dijo el asesor ML sobre esta publicacion",
      "reason": "sustancia_prohibida|falso_positivo|error_sistema|marca|politica|otro",
      "substance": "nombre de sustancia si aplica, sino null",
      "result": "aceptado|rechazado|pendiente|sin_respuesta"
    }
  ],
  "interactions": [
    {
      "date": "April 1",
      "author": "nombre de quien escribe",
      "role": "dropux|ml",
      "summary": "resumen corto de lo que dijo"
    }
  ],
  "ml_advisors": ["nombre1", "nombre2"],
  "contradictions": "si dos asesores ML se contradicen, describir aqui. null si no hay",
  "response_time_assessment": "rapido|normal|lento|sin_respuesta",
  "suspension_mentioned": true/false,
  "technical_error_mentioned": true/false
}

Reglas para classification:
- apelacion: se apela una publicacion prohibida o con infraccion
- validacion_preventiva: se pide a ML que confirme que publicaciones estan bien
- suspension: se apela suspension de cuenta
- reclamo: disputa de comprador
- exclusion_demoras: pedir que excluyan retrasos de reputacion
- operativo: envios, costos, devoluciones
- error_operativo: caso abierto en cuenta equivocada o sin resultado por error del asesor Dropux
- consulta_general: cualquier otra cosa

Reglas para inquiry_channel:
- chat: tiene timestamps con hora exacta (HH:MM:SS), burbujas, "This chat has ended"
- formulario: tiene bloques "You [fecha]" / "Mercado Libre [fecha]", textos largos, sin hora exacta

Reglas para interactions:
- Extrae CADA mensaje separado con fecha, autor y resumen corto
- En formularios puede haber varios dias de diferencia entre mensajes
- Identifica si multiples asesores ML participan

Reglas para contradictions:
- Si un asesor ML dice X y otro dice Y sobre el mismo tema, describir la contradiccion
- Ejemplo: asesor 1 dice "es un error del sistema" y asesor 2 dice "no es un error, es una nueva infraccion"
- Si no hay contradiccion, poner null

Reglas para response_time_assessment:
- rapido: ML responde el mismo dia
- normal: ML responde en 1-2 dias
- lento: ML responde despues de 3+ dias
- sin_respuesta: ML no ha respondido

Reglas para identificar advisor_dropux vs advisor_ml:
- El asesor Dropux es la PERSONA que abre el caso y escribe los mensajes del lado del vendedor. Busca cuando dice "mi nombre es X" o "hablas con X". NUNCA es el nombre de la cuenta (GLOBAL SELLER, Global technology Mi, etc). NUNCA es un codigo como UY20260210121636. Es un nombre de persona real.
- El asesor ML es quien responde con firma de "Customer Service / Mercado Libre | Mercado Pago". Busca su nombre al inicio de su primer mensaje o en su firma.
- Si no puedes identificar el nombre real del asesor Dropux, pon null. NUNCA pongas el nombre de la cuenta ni codigos.

Reglas para quality_score del asesor Dropux:
- bueno: argumento bien, con evidencia, profesional, insistio cuando debia
- regular: hizo el trabajo pero sin evidencia fuerte o con errores menores
- malo: caso en cuenta equivocada, argumento sin evidencia, no insistio cuando debia, o no se presento

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
    'ml_support_inquiries?select=inquiry_number,country,store_id,conversation_text,inquiry_status,extracted_at&conversation_text=not.is.null&order=inquiry_date.desc'
  );

  // Filter: only process inquiries without extracted_at (not yet classified)
  const toProcess = (inquiries || []).filter(inq =>
    inq.conversation_text &&
    inq.conversation_text.length > 50 &&
    !inq.extracted_at
  );

  log('info', 'inquiries_found', {
    total: (inquiries || []).length,
    to_process: toProcess.length,
    already_processed: (inquiries || []).length - toProcess.length
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

      // Update ml_support_inquiries with classification
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/ml_support_inquiries?store_id=eq.${inq.store_id}&inquiry_number=eq.${inq.inquiry_number}`, {
          method: 'PATCH',
          headers: {
            'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json', 'Prefer': 'return=minimal',
          },
          body: JSON.stringify({
            classification: result.classification || null,
            inquiry_channel: result.inquiry_channel || null,
            advisor_dropux: result.advisor_dropux || null,
            advisor_ml: (result.ml_advisors || []).join(', ') || result.advisor_ml || null,
            result: result.result || null,
            quality_score: result.quality_score || null,
            interactions: result.interactions || [],
            extracted_at: new Date().toISOString(),
            extraction_metadata: {
              quality_reason: result.quality_reason,
              suspension_mentioned: result.suspension_mentioned,
              technical_error_mentioned: result.technical_error_mentioned,
              publications_count: (result.publications || []).length,
              contradictions: result.contradictions,
              response_time: result.response_time_assessment,
              ml_advisors: result.ml_advisors,
            },
          }),
        });
      } catch (e) {
        log('warn', 'inquiry_update_failed', { inquiry: inq.inquiry_number, error: e.message });
      }

      extracted++;
      log('info', 'extracted', {
        inquiry: inq.inquiry_number,
        classification: result.classification,
        result: result.result,
        quality: result.quality_score,
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
