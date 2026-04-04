/**
 * Extrae TODA la data de un país de Supabase y la imprime organizada
 * para que el agente la tenga como contexto completo.
 *
 * Uso: node /home/node/.openclaw/workspace/scripts/analyze-country.js Colombia
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const STORE_ID = 49;
const COUNTRY_CODES = { Mexico: 'MX', Brazil: 'BR', Argentina: 'AR', Chile: 'CL', Colombia: 'CO' };
const COUNTRY = process.argv[2] || 'Colombia';
const CODE = COUNTRY_CODES[COUNTRY];

async function query(table, params) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
  });
  return resp.json();
}

(async () => {
  // Estado de cuenta
  const health = await query('ml_account_health',
    `select=*&store_id=eq.${STORE_ID}&country=eq.${CODE}&order=scraped_date.desc&limit=1`);

  // Todos los inquiries con conversaciones
  const inquiries = await query('ml_support_inquiries',
    `select=*&store_id=eq.${STORE_ID}&country=eq.${CODE}&order=inquiry_date.asc`);

  // Infracciones
  const infractions = await query('infraction_cases',
    `select=*&store_id=eq.${STORE_ID}&order=created_at.desc&limit=20`);

  // Imprimir todo organizado
  console.log(`\n========================================`);
  console.log(`REPORTE COMPLETO: ${COUNTRY} (Store ${STORE_ID})`);
  console.log(`========================================\n`);

  // Estado
  if (health.length > 0) {
    const h = health[0];
    console.log(`ESTADO DE CUENTA:`);
    console.log(`- Status: ${h.account_status}`);
    console.log(`- Motivo: ${h.status_reason || 'N/A'}`);
    console.log(`- Ultima revision: ${h.scraped_date}`);
  } else {
    console.log(`ESTADO DE CUENTA: Sin datos`);
  }

  // Inquiries
  console.log(`\n----------------------------------------`);
  console.log(`CASOS DE SOPORTE: ${inquiries.length} inquiries`);
  console.log(`----------------------------------------\n`);

  let openCount = 0;
  let completedCount = 0;

  for (const inq of inquiries) {
    if (inq.inquiry_status === 'open') openCount++;
    else completedCount++;

    console.log(`--- INQUIRY #${inq.inquiry_number} ---`);
    console.log(`Fecha: ${inq.inquiry_date}`);
    console.log(`Estado: ${inq.inquiry_status}`);
    if (inq.summary_text) console.log(`Resumen: ${inq.summary_text}`);

    if (inq.conversation_text) {
      console.log(`\nCONVERSACION COMPLETA:`);
      console.log(inq.conversation_text);
    } else {
      console.log(`(sin conversacion guardada)`);
    }
    console.log(`\n`);
  }

  console.log(`----------------------------------------`);
  console.log(`RESUMEN: ${openCount} abiertos, ${completedCount} completados, ${inquiries.length} total`);
  console.log(`----------------------------------------`);

  // Infracciones
  if (infractions.length > 0) {
    console.log(`\nINFRACCIONES RECIENTES:`);
    for (const inf of infractions) {
      console.log(`- ${inf.item_id} | ${inf.reason} | ${inf.severity} | ${inf.status} | ${inf.created_at}`);
    }
  }

  console.log(`\n========================================`);
  console.log(`FIN DEL REPORTE`);
  console.log(`========================================`);
})().catch(e => console.error('ERROR:', e.message));
