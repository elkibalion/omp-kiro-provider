# Design: manejo seguro del proceso ACP

## Contrato de comportamiento
`executeKiroAcpFallback(...)` mantiene su retorno booleano: `true` solo si ACP produjo texto y cerró el stream con éxito; `false` para cualquier fallo. Los fallos de proceso no escapan al event loop. `executeKiroRequest` conserva el error HTTP original cuando recibe `false`.

## Flujo propuesto
1. Crear el `ChildProcess` como hoy.
2. Instalar inmediatamente un listener/promise para `child.once("error")`, antes de construir el transporte ACP. Así un fallo asíncrono de `spawn` se convierte en rechazo controlado.
3. Ejecutar la conexión ACP junto con la promesa de error del proceso mediante `Promise.race`. Si ACP termina correctamente, el resultado actual no cambia; si el proceso emite `error`, se entra al `catch`.
4. En `catch (error)`, emitir `logger.error("acp_fallback_failed", { model, cliPath, error, stderr })`. El objeto `Error` y el texto de stderr pasan por `DebugLogger`, que ya redacciona campos y strings sensibles.
5. En `finally`, llamar a una utilidad local de terminación segura que no intente matar un proceso ya finalizado/marcado y que capture cualquier excepción de `kill`. El cleanup del `terminalManager` se conserva.
6. Retornar `false`; el caller publica el error HTTP original y termina el stream normalmente.

## Detalles de implementación
- Importar solo el tipo `ChildProcess` si el helper lo necesita; no añadir dependencias.
- La promesa de error debe participar en `Promise.race` para evitar rechazos no observados.
- La terminación segura debe comprobar `exitCode`, `signalCode` y `killed`; aun así envolver `kill()` en `try/catch` porque cleanup es best-effort.
- No cambiar `createAcpTerminalManager`, la lógica de permisos ni el contrato de runtime registration.
- No escribir tokens, payloads ni contexto completo al log; solo `Error`, ruta del CLI, modelo y stderr ya filtrable.

## Prueba de regresión
Añadir a `tests/kiro-stream.test.mjs` un test con:
- `globalThis.fetch` falso que devuelve HTTP 401 con un mensaje no secreto.
- `cliFallback: true` y `kiroCliPath` inexistente.
- logger stub que captura eventos.
- consumo completo del stream y `await stream.result()`.
- aserciones: `stopReason === "error"`, `errorMessage` conserva el mensaje 401, existe `acp_fallback_failed`, no hay excepción global.

## Mapeo a aceptación
- AC-001/AC-003: test de CLI inexistente y retorno del error original.
- AC-002: logger stub captura el evento y sus campos básicos.
- AC-004: helper de cleanup y test de proceso fallido.
- AC-005: suite existente más regresión.
- AC-006: typecheck, lint, test y `npm pack --dry-run`.

## Archivos permitidos
- `src/kiro.ts`: manejo del proceso ACP, logging y cleanup.
- `tests/kiro-stream.test.mjs`: regresión focalizada.
- `.kiro/specs/omp-kiro-provider-acp-fallback/*`: artefactos del ciclo.

STAGE_SUMMARY_COMPLETE
RESULTS: Diseño ejecutable definido para capturar `ChildProcess.error`, registrar diagnóstico redactable y limpiar de forma idempotente.
EVIDENCE: Research E-001..E-004; reproducción `spawn ENOENT`; contratos actuales de stream y logger.
NATIVE_AGENTS: Auditorías nativas completadas; los contratos se alinean con sus hallazgos sobre error loss y cleanup.
LOCAL_DELEGATION: BLOCKED; snapshot documentado en Research.
LOCAL_JOBS: Ningún job local completado.
LOCAL_MODELS: Ninguno completado.
LOCAL_HEALTH: LM Studio local 401; remoto no cargó el modelo elegido.
FALLBACK: Diseño basado en implementación existente, documentación oficial y pruebas locales.
OPEN_RISKS: Sin ACP autenticado real; `Promise.race` debe validarse con la suite tras implementación.
NEXT_GATE: Crear tasks.md con contratos TASK-NNN completos y gate de ejecución.
