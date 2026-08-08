# Execution: corrección ACP fallback

## Implementado
- `src/kiro.ts`: el proceso ACP ahora registra inmediatamente su evento `error` en una promesa observada por `Promise.race` junto con la conexión ACP.
- `src/kiro.ts`: los errores del fallback se registran como `acp_fallback_failed` con modelo, CLI, error y stderr opcional; el `DebugLogger` existente conserva la redacción.
- `src/kiro.ts`: cleanup best-effort e idempotente mediante comprobación de estado y `try/catch` alrededor de `kill()`.
- `tests/kiro-stream.test.mjs`: regresión para HTTP 401 + CLI inexistente, comprobando error funcional, evento de diagnóstico y ausencia de excepción global.

## Archivos modificados permitidos
- `src/kiro.ts`
- `tests/kiro-stream.test.mjs`
- artefactos `.kiro/specs/omp-kiro-provider-acp-fallback/`

## Trazabilidad
- TASK-001 → manejo del proceso, logging y cleanup.
- TASK-002 → regresión del stream y restauración de `globalThis.fetch`.
- AC-001..AC-005 quedan pendientes de aceptación ejecutada; AC-006 queda pendiente de validación completa.

## Restricciones respetadas
No se añadieron dependencias, no se tocaron credenciales, no se modificaron runtime registration/OAuth/configuración fuera de alcance y no se hizo commit, push ni publicación. Los MCP quedan pospuestos como proyectos separados.

EXECUTION_COMPLETE

STAGE_SUMMARY_COMPLETE
RESULTS: Implementación aplicada en los dos archivos permitidos y diff revisado; el fixture de regresión ahora es permanente en la suite.
EVIDENCE: Diff confirma captura de `ChildProcess.error`, `Promise.race`, log `acp_fallback_failed` y cleanup seguro.
NATIVE_AGENTS: TASK-001/TASK-002 definidos con agentes registrados; auditorías iniciales aportaron el diagnóstico.
LOCAL_DELEGATION: BLOCKED; no se usó código privado en LM Studio.
LOCAL_JOBS: Ningún job local completado; runner de jobs falló por `stdio`.
LOCAL_MODELS: Ninguno completado.
LOCAL_HEALTH: LM Studio local 401; remoto no pudo arrancar el modelo seleccionado.
FALLBACK: Implementación directa y validación local del repositorio.
OPEN_RISKS: La carrera ACP y el camino exitoso deben confirmarse con tests; no hay CLI autenticado real.
NEXT_GATE: Ejecutar typecheck, regresión, suite, lint y empaquetado; luego revisión independiente y acceptance.md/qa.md.

CLOSURE_REVALIDATION: ejecución y QA independientes revalidados en la sesión actual; no cambia producción.
