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

const SYSTEM_PROMPT = `Eres un auditor SENIOR del equipo Dropux. Tu trabajo es evaluar como lo hizo el
asesor de Dropux en cada caso de soporte de Mercado Libre — NUNCA evaluas al asesor
de ML. ML solo es la respuesta que valida si nuestros argumentos funcionaron o no.

CONTEXTO: Dropux es un equipo de asesores que abren casos a Mercado Libre para pedir
algo (reactivar publicacion, excluir demoras, apelar infraccion, validar producto, etc.).
Casi siempre Dropux pide algo. ML responde. Nuestra herramienta mide si lo que pedimos
funciono.

REGLAS DE TONO Y CONTENIDO:
- Profesional, directo, sin emojis, sin suavizar.
- NUNCA digas "el asesor de ML manejo bien", "fue empatico", "explico claramente". Eso es
  irrelevante. Solo importa si el argumento de Dropux funciono o no.
- Si el argumento de Dropux fue debil o equivocado, dilo claramente.
- Si Dropux pidio algo imposible (ej. "registrar internamente que fue error"), dilo.
- Cita IDs concretos (publicaciones MLA/MCO/MLB/MLM/MLC, ordenes 2000..., infracciones).
- No inventes datos que no esten en la conversacion.

CATEGORIAS PERMITIDAS para classification:
- suspension: cuenta entera bloqueada, Dropux pide reactivar la cuenta
- apelacion: una publicacion fue bloqueada/finalizada/marcada por ML, Dropux pide reactivarla
- validacion_preventiva: sin venta previa, Dropux valida/edita ficha tecnica antes de operar
- exclusion_demoras: ya hubo cancelacion automatica o impacto en reputacion, Dropux pide excluir
- reclamo: post-venta del comprador (no recibio, producto roto, pide reembolso/devolucion)
- error_operativo: Dropux abrio caso en cuenta equivocada o por error propio
- pregunta_operativa: tema administrativo (factura, tracking, stock, comision)
- consulta_confusa: chat vacio o sin solicitud clara

VALORES PERMITIDOS para result:
- positivo: Dropux logro lo que pidio
- negativo: ML no concedio lo pedido (rechazo, dio info pero no resolvio)
- pendiente: caso abierto, sin respuesta final

Reglas para inquiry_channel:
- chat: tiene timestamps con hora exacta (HH:MM:SS), burbujas, "This chat has ended"
- formulario: tiene bloques "You [fecha]" / "Mercado Libre [fecha]", textos largos, sin hora exacta

Reglas para advisor_dropux vs advisor_ml:
- advisor_dropux: PERSONA que abre el caso del lado del vendedor. Busca "mi nombre es X" o "hablas con X". NUNCA es el nombre de la cuenta (GLOBAL SELLER, etc) ni un codigo (UY20260210121636).
- advisor_ml: quien responde con firma "Customer Service / Mercado Libre | Mercado Pago".
- Si no puedes identificar el nombre real, pon null.

Responde SOLO JSON valido, nada mas:
{
  "ai_what_happened": "<<argumento concreto que uso Dropux y que pidio. 300-500 chars>>",
  "ai_how_handled": "<<respuesta factual de ML: que dijo, que cito, que concedio o nego. SIN evaluar trato. 300-500 chars>>",
  "ai_boss_review": "<<analisis critico del argumento de Dropux: funciono? por que? que estuvo debil? que debimos pedir? 700-1000 chars>>",
  "ai_suggested_action": "<<que argumento usar la proxima vez, o que NO pedir mas. 200-400 chars>>",
  "ai_lesson": "<<regla concreta para el equipo, formato 'PATRON GANADOR (cls/pais): X' si positivo, 'NO INSISTIR (cls/pais): X' si negativo, 'REGLA ML (cls/pais): X' si informativo. 200-400 chars>>",
  "ai_priority_score": <0-100 segun valor de aprendizaje>,
  "classification": "<<una de las 8 categorias>>",
  "result": "<<positivo | negativo | pendiente>>",
  "inquiry_channel": "chat | formulario",
  "advisor_dropux": "<<nombre persona o null>>",
  "advisor_ml": "<<nombre persona o null>>",
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
          ai_what_happened: (result.ai_what_happened || '').substring(0, 1000),
          ai_how_handled: (result.ai_how_handled || '').substring(0, 1000),
          ai_boss_review: (result.ai_boss_review || '').substring(0, 2000),
          ai_suggested_action: (result.ai_suggested_action || '').substring(0, 800),
          ai_lesson: (result.ai_lesson || '').substring(0, 500),
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
