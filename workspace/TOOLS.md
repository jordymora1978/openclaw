# Herramientas disponibles

## 1. Supabase (Base de datos)

Dos bases de datos accesibles via REST API:

**Sales DB** ($SUPABASE_URL + $SUPABASE_ANON_KEY):
- orders, ml_claims, infraction_cases, ml_support_inquiries, ml_account_health

**Catalog DB** ($SUPABASE_CATALOG_URL + $SUPABASE_CATALOG_ANON_KEY):
- imported_products, ml_publications, catalog_inventory, inventory_products

Acceso: solo lectura (SELECT) + escritura en ml_support_inquiries y ml_account_health.

## 2. Browserbase (Navegacion web)

Para acceder a MercadoLibre Global Selling. Usa Playwright + Browserbase para bypass de captcha.

Variable: $BROWSERBASE_API_KEY
Conexion: wss://connect.browserbase.com?apiKey=$BROWSERBASE_API_KEY

Credenciales ML Store 49: $ML_USER_49 y $ML_PASS_49

## 3. Telegram

Canal de comunicacion principal. Envia reportes y alertas a Jordy (ID: 1742300220).

## Notas importantes

- Siempre usa headless:true para el browser
- Siempre cierra el browser al terminar (await b.close())
- Timeout maximo de scripts: 5 minutos (300 segundos)
- Si un script falla, no reintentes mas de 2 veces
- Guarda los datos recolectados en Supabase ANTES de cerrar el browser
