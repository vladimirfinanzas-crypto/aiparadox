# Centro de integraciones

Settings → Integrations es el único sitio donde se configuran los proveedores y
servicios de Paradox. Una integración puede ser **global** (la clave vive en el
entorno del despliegue y solo la usa el operador) o **personal** (la configura el
usuario y se guarda en su fila de la base de datos).

## Qué es global y qué es personal

| Integración | Dónde vive | Quién la configura |
|---|---|---|
| Proveedores de IA (OpenRouter, Gemini, Cerebras, Groq, Workers AI) | entorno (`*_API_KEY`) | operador |
| Orden y opt-out de proveedores | `ai_provider_settings` (por usuario) | usuario |
| Trigger.dev, Postgres/Neon, Clerk, Sentry, Resend | entorno | operador |
| Browserbase | entorno (`BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`) | operador |
| Zernio | entorno (`ZERNIO_API_KEY`) + perfil por usuario | operador + usuario |
| APIs personalizadas | `custom_integrations` (por usuario) | usuario |
| Servidores MCP | `mcp_servers` (por usuario) | usuario |
| Desktop Agent | token por usuario (`integrations.pc_agent_token`) | usuario |

Las claves de servidor **nunca** llegan al navegador: la página recibe solo
booleanos (`getEnvironmentStatus()`). Las credenciales personales se guardan
cifradas y solo se devuelve su máscara.

## Un solo sistema de proveedores

`lib/ai/models.ts#catalogForRole(role, selection)` es la única función que decide
el orden de candidatos. La selección del usuario se lee **una vez por turno** en
`trigger/chat.ts` (`getProviderSelection`) y se pasa a `chatModel`, `pickAgent` y
`structuredChatModel`. Reglas de precedencia:

1. `PARADOX_DISABLED_PROVIDERS` (operador) siempre gana: el usuario no puede
   reactivar un proveedor que el servidor apagó.
2. Un proveedor desactivado por el usuario se salta solo en sus turnos.
3. El orden es el del usuario si guardó uno; si no, `PARADOX_PROVIDER_ORDER`.
4. Un proveedor sin clave se salta igualmente en el router.

Los proveedores añadidos al producto después de que alguien guardara su lista se
añaden al final, de modo que guardar nunca «pierde» un proveedor.

## Estados: configurado no es conectado

| Estado | Significado |
|---|---|
| `configured` | los campos están guardados; no se ha probado nada |
| `verified` | una petición real devolvió 2xx con la credencial guardada |
| `error` | la petición falló (host, TLS, timeout, 5xx) |
| `unverified` (MCP) | el endpoint está guardado pero no ha respondido el handshake |
| `connected` (MCP) | `initialize` + `tools/list` respondieron |

Un 401/403 de una API personalizada se muestra como «el host es correcto pero la
credencial fue rechazada»: sigue siendo un error, pero de credencial, no de red.

## Seguridad

- **SSRF**: `lib/url-safety.ts` valida toda URL configurable antes de usarla:
  solo `http(s)`, sin credenciales embebidas, sin `localhost`/`.local`/`.internal`,
  y **todas** las direcciones resueltas deben ser públicas. Las peticiones usan
  `redirect: "manual"` para que un 30x no salte a un host privado.
- **Credenciales**: AES-256-GCM con IV aleatorio por valor (`lib/secrets.ts`),
  prefijo de versión para detectar cambios de algoritmo. Sin
  `INTEGRATIONS_ENCRYPTION_KEY` la acción rechaza guardar; no hay fallback.
- **Autorización**: cada acción lee la sesión de Clerk y filtra por `userId` en
  el `where`. El id que llega del cliente se usa junto al de la sesión, nunca en
  su lugar.
- **Aislamiento**: no hay ninguna consulta de integraciones que no incluya
  `user_id`.

## MCP: qué hay y qué falta

Implementado (`lib/mcp.ts`):

- transporte **streamable HTTP** con JSON-RPC 2.0 (respuesta JSON o un único
  evento SSE);
- `initialize` → `notifications/initialized` → `tools/list`, con timeout de 10 s;
- credencial por cabecera (`Authorization: Bearer`, `x-api-key`);
- las herramientas descubiertas se guardan con el servidor y se muestran en la
  tarjeta.

Deliberadamente fuera de alcance:

- `stdio`: requeriría ejecutar un comando en el servidor. La app corre en la nube
  y no lo hace, así que ese transporte se rechaza en lugar de simularse.
- `tools/call` desde Settings: descubrir no es autorizar. La ejecución de
  herramientas pasa por el registro del agente (`docs/tool-registry.md`) y sus
  aprobaciones.
- Servidores con OAuth interactivo: no hay flujo de autorización MCP; solo
  credencial estática.

Con esto, MCP es **extensible y real para HTTP**, pero no un cliente MCP completo.

## Pruebas

- Unitarias: `lib/__tests__/secrets.test.ts`, `url-safety.test.ts`,
  `custom-integrations.test.ts`, `mcp.test.ts`,
  `lib/ai/__tests__/provider-selection.test.ts`.
- Manual en producción, con sesión iniciada: añadir una API, pulsar «Probar»,
  recargar (la credencial debe seguir enmascarada) y comprobar
  `GET /api/ai/health?probe=1` para los proveedores de IA.

## Límites conocidos

- Con `INTEGRATIONS_ENCRYPTION_KEY` rotada, las credenciales antiguas dejan de
  descifrarse: la UI lo reporta como error y hay que volver a introducirlas.
- Las APIs personalizadas se prueban con un `GET` a la URL base; no se guarda un
  «endpoint de prueba» distinto.
- Los cooldowns de proveedores viven en memoria del proceso (ver
  `docs/ai-providers.md`); el centro de integraciones no los persiste.
