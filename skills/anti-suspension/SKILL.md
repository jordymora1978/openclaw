---
name: anti-suspension
description: Gestión de infracciones, suspensiones y apelaciones en ML. Usar cuando se pregunte sobre casos, infracciones, estados de cuenta, o argumentos de apelación.
metadata:
  { "openclaw": { "emoji": "⚖️",
    "requires": { "env": ["SUPABASE_URL", "SUPABASE_ANON_KEY"] } } }
---

# Anti-Suspension — Gestion de Casos

## Estados de un caso

| Estado | Significado | Quien actua |
|--------|------------|-------------|
| INVESTIGANDO | Agente investigando producto, regulaciones, competencia | Agente |
| LISTO | Argumento armado, listo para enviar a ML | Equipo (el asesor disponible) |
| ESPERANDO | Argumento enviado, esperando respuesta de ML | ML |
| PROCESANDO | ML respondio, evaluando si escalar o cerrar | Agente |

## Flujo

```
INVESTIGANDO → LISTO → ESPERANDO → PROCESANDO
                                      ↓
                              Resolvio? → Cerrar
                              No? → INVESTIGANDO (nuevo argumento)
```

## Regla critica: maximo 5-6 casos bien argumentados

NO abrir 20 casos con argumentos genericos. Mejor 5 casos con:
- Evidencia real (links Amazon, competidores ML, regulaciones)
- Clasificacion clara (falso positivo / zona gris / prohibido)
- Argumento que el asesor disponible pueda copiar y pegar

## Consultar casos

Casos en investigacion:
```bash
curl -s "$SUPABASE_URL/rest/v1/infraction_cases?select=id,case_number,message_text,status,estado,proximo_movimiento,updated_at&estado=eq.INVESTIGANDO&order=updated_at.desc&limit=10" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY"
```

Casos listos para enviar:
```bash
curl -s "$SUPABASE_URL/rest/v1/infraction_cases?select=id,case_number,message_text,estado,proximo_movimiento&estado=eq.LISTO&order=updated_at.desc" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY"
```

Casos esperando respuesta de ML:
```bash
curl -s "$SUPABASE_URL/rest/v1/infraction_cases?select=id,case_number,message_text,estado,proximo_movimiento&estado=eq.ESPERANDO&order=updated_at.desc" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY"
```

## Actualizar caso

```bash
curl -s "$SUPABASE_URL/rest/v1/infraction_cases?id=eq.UUID" -X PATCH \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"estado":"LISTO","proximo_movimiento":"Enviar argumento a ML con links de competidores"}'
```

## Agregar al historial de conversacion

Leer historial actual, agregar entrada, guardar:
```bash
# Leer actual
curl -s "$SUPABASE_URL/rest/v1/infraction_cases?select=historial_conversacion&id=eq.UUID" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY"

# Actualizar (reemplazar array completo con la nueva entrada agregada)
curl -s "$SUPABASE_URL/rest/v1/infraction_cases?id=eq.UUID" -X PATCH \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"historial_conversacion": [{"fecha":"2026-04-04","actor":"agente","accion":"Investigo producto","detalle":"..."}]}'
```

Formato de cada entrada en historial_conversacion:
```json
{
  "fecha": "2026-04-04",
  "actor": "agente|asesor_dropux|asesor_ml",
  "accion": "Que hizo",
  "detalle": "Texto completo o resumen"
}
```

## Tablas relacionadas

- `ml_support_inquiries`: tickets de soporte scrapeados de ML (inquiry_number, conversation_text)
- `ml_account_health`: estado de cuenta por pais (account_status, status_reason)
- `appeal_knowledge_base`: RAG con patrones y estrategias aprendidas
