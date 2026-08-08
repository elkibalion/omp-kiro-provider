# Validación funcional con cliente OMP

## Entorno
- Directorio: `/Users/rodrigo/omp-plugins/omp-kiro-provider`
- OMP: `v17.2.11`
- Node: `v26.6.0`
- Kiro CLI disponible: `2.16.2`
- Plugin registrado por OMP: `omp-kiro-provider@0.1.0`, habilitado y enlazado al checkout local.
- No se usaron credenciales reales, OAuth, endpoints cloud ni login.

## Pruebas ejecutadas

### OMP-001 — Descubrimiento y salud del plugin
**Resultado: PASS**

Comandos:
- `omp plugin list --json`
- `omp plugin doctor --local --dry-run`

Evidencia:
- OMP reportó `omp-kiro-provider@0.1.0`, `enabled: true`.
- La ruta instalada es un symlink a `/Users/rodrigo/omp-plugins/omp-kiro-provider`.
- Doctor: `3 ok, 1 warnings, 0 errors`; la advertencia `package_manifest: Not created yet` no bloqueó la carga.

### OMP-002 — Wiring y streaming end-to-end
**Resultado: PASS**

Se inició un servidor HTTP temporal en `127.0.0.1` que devolvió frames AWS EventStream sintéticos (`assistantResponseEvent` y `metricsEvent`). OMP se ejecutó en modo JSON con el plugin enlazado, `kiro/auto` y una configuración temporal con token ficticio.

Evidencia observada:
- Provider: `kiro`.
- Modelo: `auto`.
- Texto recibido: `OK from local OMP mock`.
- `responseId`: `local-omp-smoke`.
- Métricas recibidas: input `3`, output `5`, total `8`.
- `stopReason`: `stop`.
- Marcador: `OMP_LOCAL_EVENTSTREAM_SMOKE=PASS`.

### OMP-003 — Propagación de herramientas
**Resultado: PASS**

OMP se ejecutó con `--tools=read` contra otro mock EventStream local. El servidor capturó el request payload y verificó la lista de herramientas.

Evidencia:
- Herramienta OMP `read` presente en `conversationState.currentMessage.userInputMessage.userInputMessageContext.tools`.
- También se observaron herramientas MCP internas de OMP.
- Texto recibido: `tools-ok`.
- `responseId`: `local-omp-tools`.
- `stopReason`: `stop`.
- Marcador: `OMP_TOOL_WIRING=PASS`.

### OMP-004 — Error operativo controlado
**Resultado: PASS como prueba negativa**

Se apuntó temporalmente el provider a `127.0.0.1:9`, sin servidor. OMP cargó el provider y seleccionó `kiro/auto`; el plugin devolvió `stopReason: error` y `Unable to connect...`. OMP aplicó sus reintentos automáticos y el proceso fue limitado por timeout, sin excepción del plugin ni tráfico externo.

## Límites
- No se ejecutó `/login kiro` ni streaming contra Kiro cloud porque no hay credenciales configuradas y no se autoriza login automático.
- No se ejecutó fallback ACP autenticado real; la regresión de CLI inexistente ya está cubierta por `tests/kiro-stream.test.mjs`.
- Los servidores mock fueron temporales y se eliminaron al finalizar cada prueba.
- No se modificaron archivos de producción, configuración global de OMP ni la instalación del plugin.

## Conclusión
La integración funcional local OMP → provider → request EventStream → respuesta OMP está verificada. El wiring de herramientas también está verificado. La única cobertura pendiente requiere credenciales reales y un endpoint Kiro autorizado.

OMP_CLIENT_VALIDATION_COMPLETE

STAGE_SUMMARY_COMPLETE
RESULTS: Pruebas funcionales OMP-001..OMP-004 ejecutadas; descubrimiento, streaming, tools y error controlado PASS.
EVIDENCE: OMP v17.2.11 produjo respuestas JSON terminales con texto, responseId, métricas y stopReason; payload de tools inspeccionado en mock local.
NATIVE_AGENTS: audit-code-deepseek y audit-architecture-glm completaron revisión independiente de la matriz OMP antes de ejecutar.
LOCAL_DELEGATION: BLOCKED; LM Studio local requiere token y no se envió código privado.
LOCAL_JOBS: Ningún job local completado.
LOCAL_MODELS: Ninguno completado.
LOCAL_HEALTH: LM Studio local HTTP 401; no necesario para las pruebas OMP locales.
FALLBACK: Mock HTTP EventStream loopback, token ficticio, plugin enlazado y comandos OMP de lectura.
OPEN_RISKS: OAuth/cloud real y ACP autenticado real siguen sin verificarse por falta de credenciales autorizadas.
NEXT_GATE: Cerrar la tarea de pruebas OMP; no hacer commit, push ni publicación.
