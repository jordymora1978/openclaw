/**
 * Extract structured context from inquiry conversations using Claude Haiku 4.5.
 *
 * Reads ml_support_inquiries (with conversation_text but no extracted_at),
 * sends each conversation to Claude to extract publication IDs, advisor
 * statements, classifications and the full Dropux-first analysis.
 * Saves results to ml_support_inquiries (PATCH) + ml_support_inquiries_ai
 * (upsert) + publication_history (per-publication events).
 *
 * Cost: ~$0.009 per conversation (Claude Haiku 4.5).
 * Run after scrape-all.js.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
// SERVICE_KEY requerido para escribir a ml_support_inquiries_ai (tabla con FORCE RLS service_role)
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const MODEL = 'claude-haiku-4-5-20251001';

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

async function supabaseUpsert(table, data, onConflict, useServiceKey = false) {
  const key = useServiceKey ? SUPABASE_SERVICE_KEY : SUPABASE_KEY;
  const resp = await fetch(
    `${SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`,
    {
      method: 'POST',
      headers: {
        'apikey': key, 'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(data),
    }
  );
  if (!resp.ok) {
    const errBody = await resp.text();
    log('warn', 'upsert_failed', { table, status: resp.status, error: errBody.substring(0, 200) });
  }
  return resp.ok;
}

const SYSTEM_PROMPT = `Resumis casos de soporte de Mercado Libre para que un admin haga auditoria
rapida. Tono conversacional, como si le contaras a un compañero en 1 minuto.
Frases cortas. Sin frases formales tipo "se realizo analisis tecnico" o
"se manejo con empatia".

Lo unico que importa es:
1. Que se solicito (en simple)
2. Como nos fue (resultado real)
3. Si hay algo concreto que implementar (regla, paso, accion). Si no hay nada
   concreto, deja accion vacia ("").

NO inventes. NO menciones nombres de asesores ML. NO uses tecnicismos.
Cita IDs solo si aparecen (publicaciones MLA/MCO/MLB/MLM/MLC, ordenes 2000...).

CATEGORIAS para classification:
- suspension: cuenta entera bloqueada, se pide reactivar la cuenta
- apelacion: una publicacion bloqueada/finalizada/marcada, se pide reactivarla
- validacion_preventiva: sin venta previa, se valida/edita ficha antes de operar
- exclusion_demoras: ya hubo cancelacion o impacto en reputacion, se pide excluir
- reclamo: post-venta del comprador (no recibio, producto roto, reembolso)
- error_operativo: caso abierto en cuenta equivocada o por error propio
- pregunta_operativa: tema administrativo (factura, tracking, stock, comision)
- consulta_confusa: chat vacio o sin solicitud clara

VALORES para result:
- positivo: se logro lo solicitado
- negativo: no se concedio (rechazo o solo info sin resolver)
- pendiente: caso abierto, sin respuesta final

inquiry_channel:
- chat: tiene timestamps tipo HH:MM:SS
- formulario: bloques "You [fecha]" / "Mercado Libre [fecha]"

REGLA CRITICA para diferenciar advisor_dropux vs advisor_ml:
1. En los chats hay dos lados claros:
   - El VENDEDOR (Dropux) escribe siempre con un NICK como "UY20260210121636",
     "MA20260...", "AR2026..." (codigo de pais + numeros). NUNCA con nombre.
   - El asesor de MERCADO LIBRE escribe con un NOMBRE HUMANO (Ramiro, Federico,
     Valentina, Martina, Tomas, Sofia, Abril, Daniela, Rubi, Camilo, etc).
2. advisor_dropux: el nombre HUMANO de la persona del lado vendedor. Solo lo
   sabes si el mensaje del nick UY.../MA.../etc dice literalmente
   "mi nombre es X", "hablas con X", "soy X", o "Hola, soy X". Casi siempre
   es Yelitza. Si el lado nick nunca dijo su nombre humano, devuelve null.
3. advisor_ml: el NOMBRE HUMANO que aparece como autor (sin nick) de los
   mensajes en el chat. Es el del LADO IZQUIERDO conceptualmente.
4. NUNCA confundas: si en el chat aparece "Hola Ramiro, mi nombre es Yelitza"
   escrito por el nick UY..., entonces:
     advisor_dropux = "Yelitza" (porque el lado nick dice "mi nombre es Yelitza")
     advisor_ml    = "Ramiro"  (porque Ramiro es a quien le habla, y aparece
                                como autor en el otro lado)
5. Si no puedes identificar uno de los dos con certeza, devuelve null para
   ese campo. NUNCA pongas el mismo nombre en los dos.

Responde SOLO JSON valido:
{
  "ai_what_happened": "<<que se solicito, 1-2 frases simples y naturales. 100-200 chars>>",
  "ai_how_handled": "<<como nos fue, resultado real en 1-2 frases. 100-200 chars>>",
  "ai_suggested_action": "<<SOLO si hay algo concreto que implementar. Si no hay, deja vacio \\"\\". Maximo 1 frase. 0-150 chars>>",
  "ai_priority_score": <0-100>,
  "classification": "<<una de las 8 categorias>>",
  "result": "<<positivo | negativo | pendiente>>",
  "inquiry_channel": "chat | formulario",
  "advisor_dropux": "<<nombre o null>>",
  "advisor_ml": "<<nombre o null>>",
  "publications": [
    {
      "ml_item_id": "MCO1234567",
      "advisor_said": "texto corto de lo que dijo el asesor ML sobre esta publicacion",
      "reason": "sustancia_prohibida|falso_positivo|error_sistema|marca|politica|otro",
      "substance": "nombre de sustancia si aplica, sino null"
    }
  ]
}

ai_priority_score:
- 0-30: rutinario, leccion ya conocida
- 31-50: leccion util pero especifica a un solo producto
- 51-75: regla operativa que afecta varios productos o un pais entero
- 76-90: regla que cambia procedimientos core
- 91-100: critico (riesgo de suspension masiva, decision pendiente con $ en juego)`;

const VALID_CLS = new Set([
  'suspension', 'apelacion', 'validacion_preventiva', 'exclusion_demoras',
  'reclamo', 'error_operativo', 'pregunta_operativa', 'consulta_confusa',
]);
const RESULT_TO_LEGACY = { positivo: 'resuelto', negativo: 'rechazado', pendiente: 'pendiente' };

async function extractWithClaude(conversation, inquiryNumber, country) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2500,
      temperature: 0.3,
      system: SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: `Inquiry #${inquiryNumber} (${country}):\n\n${conversation.substring(0, 8000)}` },
      ],
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Anthropic error: ${resp.status} ${err.substring(0, 200)}`);
  }

  const data = await resp.json();
  let text = (data.content || []).map(b => b.text || '').join('').trim();
  if (text.startsWith('```')) {
    text = text.split('```')[1] || text;
    if (text.startsWith('json')) text = text.slice(4);
  }
  text = text.trim();

  try {
    const parsed = JSON.parse(text);
    // Normalize
    let cls = (parsed.classification || 'consulta_confusa').toLowerCase();
    if (!VALID_CLS.has(cls)) cls = 'consulta_confusa';
    let res = (parsed.result || 'negativo').toLowerCase();
    if (!['positivo', 'negativo', 'pendiente'].includes(res)) res = 'negativo';
    parsed.classification = cls;
    parsed.result_binary = res;
    parsed.result_legacy = RESULT_TO_LEGACY[res];
    return parsed;
  } catch (e) {
    log('warn', 'json_parse_failed', { inquiry: inquiryNumber, raw: text.substring(0, 200) });
    return null;
  }
}

(async () => {
  log('info', 'extract_start', { model: MODEL });

  if (!ANTHROPIC_KEY) {
    log('error', 'no_anthropic_key');
    process.exit(1);
  }

  const inquiries = await supabaseGet(
    'ml_support_inquiries?select=inquiry_number,country,store_id,conversation_text,inquiry_status,extracted_at&conversation_text=not.is.null&order=inquiry_date.desc'
  );

  const toProcess = (inquiries || []).filter(inq =>
    inq.conversation_text &&
    inq.conversation_text.length > 50 &&
    !inq.extracted_at
  );

  log('info', 'inquiries_found', {
    total: (inquiries || []).length,
    to_process: toProcess.length,
    already_processed: (inquiries || []).length - toProcess.length,
  });

  let extracted = 0;
  let events_created = 0;
  let errors = 0;

  for (const inq of toProcess) {
    try {
      log('info', 'processing', { inquiry: inq.inquiry_number, country: inq.country });

      const result = await extractWithClaude(inq.conversation_text, inq.inquiry_number, inq.country);
      if (!result) { errors++; continue; }

      // Per-publication events in publication_history
      for (const pub of (result.publications || [])) {
        if (!pub.ml_item_id) continue;
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
              reason: pub.reason,
              substance: pub.substance,
            },
          });
          events_created++;
        }
        if (pub.reason) {
          await supabasePost('publication_history', {
            ml_item_id: pub.ml_item_id,
            store_id: inq.store_id,
            country: inq.country,
            event_type: 'clasificacion',
            source: 'inquiry_extraction',
            source_ref: `inquiry:${inq.inquiry_number}`,
            content: `${pub.reason}${pub.substance ? ': ' + pub.substance : ''}`,
            metadata: { reason: pub.reason, substance: pub.substance },
          });
          events_created++;
        }
      }

      // Update ml_support_inquiries with classification + result legacy
      await fetch(`${SUPABASE_URL}/rest/v1/ml_support_inquiries?store_id=eq.${inq.store_id}&inquiry_number=eq.${inq.inquiry_number}`, {
        method: 'PATCH',
        headers: {
          'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json', 'Prefer': 'return=minimal',
        },
        body: JSON.stringify({
          classification: result.classification,
          result: result.result_legacy,
          inquiry_channel: result.inquiry_channel || null,
          advisor_dropux: result.advisor_dropux || null,
          advisor_ml: result.advisor_ml || null,
          extracted_at: new Date().toISOString(),
        }),
      });

      // Upsert ml_support_inquiries_ai con SERVICE_KEY (tabla con FORCE RLS)
      await supabaseUpsert(
        'ml_support_inquiries_ai',
        {
          store_id: inq.store_id,
          inquiry_number: inq.inquiry_number,
          ai_what_happened: (result.ai_what_happened || '').substring(0, 500),
          ai_how_handled: (result.ai_how_handled || '').substring(0, 500),
          ai_boss_review: null,  // deprecado
          ai_suggested_action: (result.ai_suggested_action || '').substring(0, 300),
          ai_lesson: null,  // deprecado
          ai_priority_score: parseInt(result.ai_priority_score) || 50,
          ai_model_used: 'claude-haiku-4-5',
          ai_enriched_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        'store_id,inquiry_number',
        true,  // useServiceKey
      );

      extracted++;
      log('info', 'extracted', {
        inquiry: inq.inquiry_number,
        classification: result.classification,
        result: result.result_binary,
        publications: (result.publications || []).length,
      });

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
    cost_estimate: `$${(extracted * 0.009).toFixed(2)}`,
  });
})().catch(e => { log('error', 'fatal', { error: e.message }); process.exit(1); });
