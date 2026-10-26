# Paradox

Plataforma de automatización con IA. La persona describe lo que quiere conseguir en lenguaje natural y **Godfather** —el agente principal— lo interpreta, elige herramientas, construye soluciones (paneles, automatizaciones), ejecuta tareas autorizadas y devuelve el resultado. Todo funciona sobre una app Next.js con autenticación propia, base de datos Postgres y un motor de ejecución durable.

---

## Arquitectura

| Capa | Tecnología | Dónde vive |
|---|---|---|
| App web (App Router) | Next.js 16 (Turbopack), React | `app/`, `components/`, `features/` |
| Autenticación | Clerk (`clerkMiddleware`) | `proxy.ts` (middleware), `app/layout.tsx` |
| Base de datos | Postgres (Neon) + Drizzle ORM (pool en `db/index.ts`) | `db/schema.ts`, `queries/`, `drizzle/` |
| Chat y agentes | Trigger.dev v4 — tarea `chat` con sesiones, transcript y streaming | `trigger/chat.ts`, `actions/chat.ts` |
| Motor de automatizaciones | Trigger.dev — `run-automation` (ejecución) y `fire-automation` (cron durable) | `trigger/run-automation.ts`, `trigger/fire-automation.ts` |
| Modelos de IA | AI SDK + router propio con 5 proveedores y escalera de fallback | `lib/ai/` (router, providers, fallback, cuotas) |
| Ejecución local | Desktop Agent (Python) que sondea la cola de trabajos | `pc-agent/agent.py`, `app/api/pc/jobs/`, `lib/pc.ts` |
| Navegación cloud | Browserbase (Stagehand) | `lib/browser*.ts` |
| Email transaccional | Resend | `lib/resend.ts` |
| Observabilidad | Sentry (server, client, edge + tunnel `/monitoring`) | `sentry.*.config.ts`, `next.config.ts` |
| Errores/estado en vivo | Live View (proyección de las tablas del backend) | `queries/live.ts`, `app/api/live/route.ts` |

**Liveblocks ya no se usa**: no queda ninguna referencia ni en el código ni en `package.json`. El editor de automatizaciones y los paneles son componentes propios.

### Superficies principales (dashboard)

| Ruta | Qué es |
|---|---|
| `/` | Landing pública. Con sesión, redirige a `/chats` (la landing se pide con `?landing=1`, nunca cierra sesión) |
| `/chats`, `/chats/[chatId]` | **Godfather**: chat-first, historial persistente, adjuntos, «Nuevo chat» |
| `/widgets`, `/widgets/[id]` | **Workspace**: paneles/herramientas creados en lenguaje natural, con versiones |
| `/workflows`, `/workflows/[id]` | **Automations**: editor visual de bloques, validación, pruebas, aprobación, ejecución e historial |
| `/settings` | **Settings** con pestañas: General, Integrations, Activity, Desktop Agent |
| `/activity`, `/integrations`, `/agents` | Rutas antiguas: redirigen a su pestaña de Settings (o a `/chats`) |
| `/api/health` | Healthcheck de despliegue (200 si el servidor está arriba) |
| `/api/ai/health` | Estado del runtime de IA (solo sesión iniciada; `?probe=1` llama a cada modelo) |
| `/api/live` | Feed de Live View (solo sesión iniciada, `no-store`) |
| `/api/pc/jobs` | Cola del Desktop Agent (autenticación por token de dispositivo) |
| `/api/desktop/enrollments[...]` | Emparejamiento del Desktop Agent por código de un solo uso |

---

## Configuración local

Requisitos: **Node.js 20.9+**, una base **Postgres** (p. ej. Neon), cuentas en **Clerk** y **Trigger.dev**, y **Python 3** solo si vas a probar el Desktop Agent.

```bash
# 1. Dependencias
npm install

# 2. Variables de entorno
cp .env.example .env.local
#   edita .env.local y rellena al menos:
#   DATABASE_URL, DATABASE_URL_UNPOOLED, CLERK_SECRET_KEY,
#   NEXT_PUBLIC_APP_URL, NEXT_PUBLIC_SITE_URL, TRIGGER_SECRET_KEY
#   + las claves de IA que tengas (ver tabla siguiente)

# 3. Migraciones de base de datos (ver sección siguiente)
node scripts/apply-migration.mjs drizzle/0000_melted_leper_queen.sql
node scripts/apply-migration.mjs drizzle/0001_desktop_devices.sql
node scripts/apply-migration.mjs drizzle/0002_executions.sql
node scripts/apply-migration.mjs drizzle/0003_execution_tasks.sql
node scripts/apply-migration.mjs drizzle/0004_automations.sql
node scripts/apply-migration.mjs drizzle/0005_automation_step_unique.sql
node scripts/apply-migration.mjs drizzle/0006_workspace_versions.sql
node scripts/apply-migration.mjs drizzle/0007_integration_center.sql

# 4. App + worker de Trigger.dev (dos terminales)
npm run dev          # Next.js en http://localhost:3000
npm run dev:worker   # worker: chat, automatizaciones y programaciones
```

> **Importante:** sin `npm run dev:worker` el chat no responde y las automatizaciones no corren: la app solo encola la sesión; el worker es quien ejecuta el turno del modelo.

---

## Variables de entorno

Plantilla completa en [`.env.example`](.env.example) (nombres y comentarios, sin secretos). Se lee de `.env.local` (desarrollo) o del panel de variables de la plataforma (producción).

| Variable | Propósito | Necesaria |
|---|---|---|
| `DATABASE_URL` | Conexión pooling a Postgres (app) | Sí |
| `DATABASE_URL_UNPOOLED` | Conexión directa para migraciones (DDL) | Sí (migraciones) |
| `CLERK_SECRET_KEY` | Secreto de Clerk (servidor) | Sí |
| `NEXT_PUBLIC_APP_URL` / `NEXT_PUBLIC_SITE_URL` | URLs públicas de la app | Sí |
| `OPENROUTER_API_KEY` | Proveedor principal de IA | Recomendada (1 de 5) |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Gemini (fallback; acepta también `GOOGLE_API_KEY`) | Opcional |
| `CEREBRAS_API_KEY` | Fallback rápido | Opcional |
| `GROQ_API_KEY` | Fallback rápido | Opcional |
| `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` | Workers AI (fallback auxiliar) | Opcional |
| `TRIGGER_SECRET_KEY` | Trigger.dev (chat + automatizaciones + schedules) | Sí |
| `BROWSERBASE_API_KEY` + `BROWSERBASE_PROJECT_ID` | Navegador cloud de Godfather | Opcional |
| `RESEND_API_KEY` + `RESEND_FROM` | Email (`send-email` y tool `email_send`) | Opcional |
| `ZERNIO_API_KEY` | Integración Zernio | Opcional |
| `INTEGRATIONS_ENCRYPTION_KEY` | Clave AES-256-GCM para las credenciales que el usuario guarda en el centro de integraciones (`openssl rand -base64 32`). Sin ella no se guarda ninguna credencial | Recomendada |
| `SENTRY_ORG` / `SENTRY_PROJECT` / `SENTRY_AUTH_TOKEN` / `NEXT_PUBLIC_SENTRY_DSN` | Sentry (build + runtime) | Opcional |
| `PARADOX_PROVIDER_ORDER`, `PARADOX_DISABLED_PROVIDERS`, `PARADOX_MODEL_*`, `PARADOX_AI_MAX_*`, `PARADOX_COOLDOWN_*`, `OPENROUTER_BACKSTOP_MODEL` | Ajuste del router de IA (documentadas en la plantilla) | No |
| `PARADOX_DESKTOP_CHANNEL` | Canal del instalador que sirve `/api/desktop/download` | No |

La app arranca con **cualquier subconjunto** de claves de IA: un proveedor sin clave se omite y responden los demás (ver `docs/ai-providers.md`). Ninguna clave de servidor llega al navegador.

---

## Base de datos y migraciones

- Esquema: `db/schema.ts` (Drizzle). Todas las tablas llevan `user_id` y las consultas de `queries/` filtran por el usuario de la sesión.
- Migraciones SQL versionadas en `drizzle/` (`0000`…`0007`), **aditivas y re-ejecutables** (`if not exists` / `on conflict`).
- El runner es `scripts/apply-migration.mjs <archivo.sql>` (usa la conexión directa, `DATABASE_URL_UNPOOLED`).
- ⚠️ `drizzle/meta/_journal.json` solo registra `0000`: **`npm run db:migrate` (drizzle-kit) no aplica `0001`–`0007`**. Aplica esos archivos con el runner, en orden, como muestra la sección anterior. `npm run db:generate` sigue siendo el camino para *crear* una migración nueva a partir de cambios de esquema.
- **Antes de un cambio que pueda tocar datos**: copia de seguridad (`pg_dump "$DATABASE_URL" > respaldo.sql`) y restaura con `psql < respaldo.sql`. No borres ni recrees tablas como solución.

---

## Proveedores de IA

Cinco proveedores detrás de un router (`lib/ai/model-router.ts`): OpenRouter primero; Gemini, Cerebras, Groq y Workers AI como escalera de fallback, con cuotas, cooldowns y límite de reintentos por petición.

- Documentación completa: [`docs/ai-providers.md`](docs/ai-providers.md)
- Diagnóstico en vivo: `GET /api/ai/health` (con sesión) — clave visible, modelos configurados y, con `?probe=1`, una llamada mínima a cada proveedor configurado (a través de su propio adaptador) y a cada modelo de OpenRouter, con presupuesto acotado (~8 s) para caber en una función de Netlify.
- Registro de herramientas del agente: [`docs/tool-registry.md`](docs/tool-registry.md)
- Navegación de Godfather: [`docs/godfather-browser.md`](docs/godfather-browser.md)
- **Daytona (opcional)** — sandboxes de los agentes de chat (`DAYTONA_API_KEY`).
  Sin esa clave no existe ninguna sandbox: la tarea `meter-sandboxes` lo
  registra en sus logs y termina sin facturar en lugar de fallar cada 5 minutos.

---

## Centro de integraciones (Settings → Integrations)

Un solo lugar para proveedores, APIs y herramientas, agrupado por categoría
(IA, navegadores, APIs externas, MCP, comunicación, redes sociales, otras).

- **Godfather es el sistema, no un proveedor.** El panel de prioridad lee el
  mismo catálogo que el router (`providerConfigurations()`) y guarda
  `ai_provider_settings`; `trigger/chat.ts` lee esa selección una vez por turno y
  se la pasa a `chatModel`/`pickAgent`. No hay un segundo sistema de proveedores.
  La lista del operador (`PARADOX_DISABLED_PROVIDERS`) siempre gana.
- **Configurado ≠ conectado.** Una API o un servidor MCP guardado se muestra
  como «configurada, sin verificar» hasta que «Probar» hace una petición real.
- **APIs personalizadas**: URL validada contra la red real (sin `localhost`,
  `.local`, rangos privados ni metadata de cloud — `lib/url-safety.ts`),
  credencial cifrada con AES-256-GCM (`lib/secrets.ts`) y solo una máscara
  visible después (`••••3456`). Sin `INTEGRATIONS_ENCRYPTION_KEY` no se guarda
  nada: no hay fallback en texto plano.
- **MCP**: handshake real por HTTP (`initialize` + `notifications/initialized` +
  `tools/list`). `stdio` no se admite: la app corre en la nube y no ejecuta
  comandos locales. Descubrir herramientas no las ejecuta; las llamadas siguen
  pasando por el registro de herramientas del agente.
- Detalles, modelo de datos y límites: [`docs/integrations.md`](docs/integrations.md).

---

## Motor de ejecución y programaciones

- **Chat (Godfather)**: `trigger/chat.ts` — sesión por conversación, transcript persistente, streaming al navegador y contabilidad por turno (`onTurnComplete` → ledger de uso + Sentry).
- **Automatizaciones**: `trigger/run-automation.ts` ejecuta la definición paso a paso (validación, datos entre pasos, reintentos, errores, límites); cada ejecución deja fila en `automation_runs` + `automation_run_steps`.
- **Programaciones**: `trigger/fire-automation.ts` es una *schedule task* de Trigger.dev (cron con zona horaria). Cada instante programada se hace efectiva con clave de idempotencia (`schedule:<workflowId>:<stamp>`), de modo que un reintento del entregador nunca duplica la ejecución. La fila `workflows.next_run_at` se mantiene honesta aunque nadie tenga la página abierta.
- **Métricas**: `trigger/usage.ts` mide sandboxes periódicamente.
- Las ejecuciones **no dependen del navegador abierto**: viven en Trigger.dev; el historial se consulta después en `/workflows/[id]`.
- Activación: Godfather puede construir/validar/probar, pero **activar requiere aprobación explícita** (`workflows.status = pending_approval`), vinculada a la versión revisada.

---

## Desktop Agent

Flujo de emparejamiento:

1. El agente local pide un código: `POST /api/desktop/enrollments` (con throttle; no autoriza nada por sí solo).
2. La persona lo aprueba con sesión iniciada en **Settings → Desktop Agent** (server action `approveDesktopCode`).
3. El agente canjea el código una única vez (`GET /api/desktop/enrollments/:code` → `token`), y a partir de ahí sondea `GET /api/pc/jobs` con ese token: cada token corresponde a **una** persona y **una** cola; nunca ve trabajos ajenos.

```bash
npm run desktop:dev       # agente local contra http://localhost:3000
npm run desktop:test      # pruebas Python del agente/instalador
npm run desktop:build     # empaquetado de canal development
npm run desktop:verify    # verificación del paquete
```

Detalle completo en [`desktop/README.md`](desktop/README.md). Sin agente conectado, la app lo dice y las tareas locales quedan en espera — nunca se simula que terminaron.

---

## Integrations (Settings)

**Settings → Integrations** (`queries/integrations.ts`) muestra qué proveedores están *realmente* configurados leyendo la presencia de sus variables en el servidor: OpenRouter, Browserbase, Trigger.dev, base de datos, Resend… Solo muestra «conectado» lo que verifica. Las claves secretas nunca se muestran ni se envían al cliente; se configuran en `.env.local` (desarrollo) o en las variables de la plataforma (producción).

---

## Pruebas y calidad

```bash
npm run lint        # ESLint (flat config; ignora cachés de build)
npm run typecheck   # tsc --noEmit
npm run test        # vitest run — 196 pruebas en 24 archivos (12 se omiten sin DATABASE_URL)
npm run desktop:test  # pruebas del Desktop Agent (unittest de Python)
npm run build       # build de producción de Next.js
```

- Hay pruebas **unitarias** (router de IA, fallback, motor de automatizaciones, registro de herramientas, Live View…) y pruebas **de integración contra la base de datos real** (`*.db.test.ts`: versiones de paneles, aislamiento entre usuarios, deduplicación de ejecuciones, tareas de ejecución, feed en vivo). Esas necesitan `DATABASE_URL`/`DATABASE_URL_UNPOOLED` apuntando a una base de desarrollo.
- **No hay suite E2E** (Playwright/Cypress) en el repo: los recorridos completos de UI se verifican a mano. Es una deuda documentada, no un paso fallido.

---

## Despliegue

**Netlify (producción: https://aiparadox.netlify.app)** — el sitio está conectado a este repositorio, así que cada push a `main` compila y despliega. `netlify.toml` fija `NODE_VERSION=22` (Next 16 exige ≥ 20.9) y `publish = ".next"`, que es lo que espera el runtime de Next.js de Netlify.

El build **no** necesita base de datos ni claves de IA: el cliente Postgres y los proveedores se crean en la primera consulta, no al importar el módulo (así `next build` se puede reproducir desde un checkout limpio). Lo que sí tiene que existir en **Site configuration → Environment variables**:

| Variable | Por qué |
|---|---|
| `DATABASE_URL`, `DATABASE_URL_UNPOOLED` | consultas en runtime y migraciones |
| `CLERK_SECRET_KEY` | sesión en el servidor |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | se **inyecta en el bundle al compilar**: sin ella el deploy publica una app que no puede iniciar sesión |
| `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SITE_URL` | URLs públicas |
| `TRIGGER_SECRET_KEY` | chat y automatizaciones |

El worker de Trigger.dev **no** lo despliega Netlify: va aparte (bloque siguiente). `GET /api/health` queda fuera del middleware de Clerk a propósito, para que el healthcheck siga respondiendo aunque la configuración de auth esté incompleta.

**Plataforma Node (p. ej. Railway — `next.config.ts` ya lee `RAILWAY_GIT_COMMIT_SHA`):**

```bash
npm ci
npm run build
npm start
# Variables de la plataforma: todas las "Sí" de la tabla de entorno
# Healthcheck: GET /api/health → 200
```

**Worker de Trigger.dev (obligatorio, separado del servidor web):**

```bash
npx --yes trigger.dev@4.7.4 deploy          # despliega el bundle a prod
npx --yes trigger.dev@4.7.4 runs list -e prod    # comprueba ejecuciones
npx --yes trigger.dev@4.7.4 report health -e prod # salud del worker
npx --yes trigger.dev@4.7.4 env list -e prod     # variables configuradas (sin valores)
# Requiere TRIGGER_SECRET_KEY y el proyecto configurado en trigger.config.ts
```

El worker de producción ya está desplegado (proyecto `Automacion`, entorno
`prod`). Sus variables se cargan con `npx trigger.dev@4.7.4 env set NOMBRE
VALOR --secret` (nunca las imprimas). Verificación registrada: el cron de 5
minutos de `meter-sandboxes` pasa de `FAILED` (faltaba Daytona) a `COMPLETED`
desde la versión `20261025.3`.

**Base de datos:** aplica `drizzle/0001`–`0006` en el entorno con `node scripts/apply-migration.mjs` (son aditivas; sigue siendo recomendable un respaldo previo).

**Cloudflare/Freebuff Sites:** existe `freebuff.open-next.config.ts` (configuración OpenNext generada) por si se publica como Worker; en esta fase **no se ha verificado un despliegue real por esa vía**.

**Sentry:** sin `SENTRY_AUTH_TOKEN` el build sigue funcionando (solo no sube source maps).

---

## Diagnóstico de errores frecuentes

| Síntoma | Causa probable | Qué hacer |
|---|---|---|
| Godfather no responde / gira eternamente | No corre el worker o falta clave de IA | `npm run dev:worker`; revisa `GET /api/ai/health` y `docs/ai-providers.md` |
| 401 en APIs de la app | Sin sesión o token caducado | Iniciar sesión de nuevo (Clerk) |
| 401 en `/api/pc/jobs` | Token de dispositivo ausente/revocado | Rearmar el agente en Settings → Desktop Agent |
| «Tarea local esperando» | Desktop Agent desconectado | Abrir el agente local; el estado real está en Live View |
| Todas las rutas responden 500 salvo `/api/health` | Faltan las claves de Clerk (`CLERK_SECRET_KEY` y, sobre todo, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`), que se inyecta al compilar | Añádelas en las variables de entorno y vuelve a desplegar |
| El build falla en «Collecting page data» / `PLATFORM_ENV_NOT_INJECTED` | Un módulo leía `DATABASE_URL` al importarse (ya corregido: se lee en la primera consulta) | Si reaparece, busca lecturas de entorno a nivel de módulo |
| Migración «ya existe» / columna inexistente | Base desalineada del journal | Aplica los SQL con `apply-migration.mjs` en orden; no uses `db:push` en producción |
| Las automatizaciones no disparan | Schedule no creado o worker caído | Comprueba `workflows.next_run_at` y el worker de Trigger.dev |
| Errores de hidratación | Extensión del navegador o branch `typeof window` | Ver consola; el tema aplica `suppressHydrationWarning` en `<html>` |

---

## Seguridad (resumen)

- Todo el dashboard pasa por `clerkMiddleware` (`proxy.ts`); las Server Actions y rutas API validan sesión **y** pertenencia (`userId` en cada `WHERE`).
- El Desktop Agent se autentica con token de dispositivo de un solo uso por emparejamiento, acotado a su persona.
- Secretos solo en variables de servidor: nunca en el cliente, logs ni respuestas de error.
- Los webhooks/entradas externas se validan (códigos de emparejamiento con expiración y canje único, claves de idempotencia en ejecuciones).
- Sin ejecución de código generado por el modelo dentro del proceso principal: los paneles son documentos de bloques validados y las automatizaciones pasan por el catálogo de nodos del motor.

---

## Documentación relacionada

- [`docs/ai-providers.md`](docs/ai-providers.md) — router, fallback y cuotas de IA
- [`docs/tool-registry.md`](docs/tool-registry.md) — herramientas de Godfather y sus integraciones
- [`docs/godfather-browser.md`](docs/godfather-browser.md) — navegador cloud/local de Godfather
- [`desktop/README.md`](desktop/README.md) — agente de escritorio, builds y releases
