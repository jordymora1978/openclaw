# Verificaciones periodicas

En cada heartbeat, revisa rapidamente:

1. Hay ordenes sin compra Amazon de mas de 24h? (store 49 y 51)
2. Hay reclamos abiertos (ml_claims status=open)?
3. Ultimo scrape de ml_account_health fue hace mas de 8 horas?

Si alguna verificacion falla, alerta por Telegram.
