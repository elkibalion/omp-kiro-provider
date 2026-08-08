# Acceptance Criteria: ACP fallback

## Resultado
ACCEPTANCE_COMPLETE

| Criterio | Estado | Evidencia fresca |
|---|---|---|
| AC-001 | PASS | `npm run check` ejecutó la regresión `ACP fallback keeps an invalid CLI path inside the stream error contract`; el stream terminó con `stopReason: error` y no hubo excepción global. |
| AC-002 | PASS | La regresión capturó `acp_fallback_failed` y verificó `failure.details.cliPath`; la implementación registra modelo, CLI, error y stderr mediante `logger.error`. |
| AC-003 | PASS | La regresión verificó el mensaje canónico `HTTP 401 (unauthorized)` después de que ACP devolvió `false`; el error original no se convierte en éxito. |
| AC-004 | PASS | `src/kiro.ts` comprueba `killed`, `exitCode` y `signalCode`, y protege `kill()` con `try/catch`; `npm run check` pasa el camino de CLI inexistente. |
| AC-005 | PASS | `npm run check`: typecheck, lint, build y 26 pruebas pasan; no fallan las pruebas existentes de auth, headers, stream, herramientas, OAuth o runtime registration. |
| AC-006 | PASS | `npm run check` pasa en Node `v26.6.0`; `npm pack --dry-run` pasa y muestra 17 archivos empaquetados. No se pudo ejecutar matriz Node 20/22/24 separada en este entorno. |

## Dictamen
Todos los criterios críticos y funcionales pasan en el entorno disponible. La aceptación no afirma validación de un CLI ACP autenticado real ni de otras versiones externas de `kiro-cli`; esas limitaciones quedan abiertas y no bloquean el fallo reproducido de spawn.

## Revisión delegada
`reviewer-kiro` / `claude-haiku-4.5` emitió `PASS` independiente y confirmó AC-001..AC-006 contra las rutas/líneas actuales. No solicitó cambios.

STAGE_SUMMARY_COMPLETE
RESULTS: AC-001..AC-006 trazados con evidencia fresca; todos PASS en el entorno disponible.
EVIDENCE: npm run check 26/26; typecheck/lint/build PASS; npm pack --dry-run PASS; revisión independiente PASS.
NATIVE_AGENTS: reviewer-kiro completado con dictamen PASS; auditorías iniciales también completadas.
LOCAL_DELEGATION: BLOCKED; LM Studio local 401 y job remoto no pudo cargar el modelo.
LOCAL_JOBS: Ningún job local completado.
LOCAL_MODELS: Ninguno completado.
LOCAL_HEALTH: endpoint local requiere Bearer token; attobeast sano pero modelo elegido falló al iniciar.
FALLBACK: Validación local del repositorio y revisión nativa independiente.
OPEN_RISKS: Sin CLI ACP autenticado real, sin matriz Node 20/22/24 y sin prueba contra varias versiones externas.
NEXT_GATE: Crear qa.md con QA semántico, operativo, wiring y visual not_applicable; luego cierre.
