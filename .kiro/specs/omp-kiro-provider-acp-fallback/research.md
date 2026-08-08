# Research: corrección del fallback ACP

## Pregunta de investigación
¿Qué componentes existentes deben reutilizarse para evitar que un fallo de `kiro-cli acp` produzca una excepción no capturada y para conservar un diagnóstico seguro?

## Inventario de reutilización

| Candidato existente | Consumidor/propietario | Compatibilidad con el bugfix | Decisión | Verificación |
|---|---|---|---|---|
| `DebugLogger.error()` y `redactForDebugLog()` | `src/debug-logger.ts`, usado por `kiro.ts`, `oauth.ts` y `eventstream.ts` | Acepta `Error`, redacción recursiva de mensajes, stacks y campos sensibles | **Reutilizar**; no crear logger paralelo | Test existente de redacción; añadir comprobación del evento ACP en el logger stub |
| `redactSensitiveString()` | `src/debug-logger.ts`, usado por errores de Kiro/OAuth | Compatible para mensajes y stderr; mantiene contrato actual | **Reutilizar** como defensa adicional al construir detalles | Test existente `debug redaction...` |
| `createKiroStream()` / `executeKiroRequest()` | `src/kiro.ts` | Es el productor del stream y el dueño del fallback tras HTTP auth failure | **Extender** solo el manejo del fallback; conservar error HTTP original | Reproducción 401 + CLI inválido y suite `kiro-stream.test.mjs` |
| `createAcpTerminalManager()` | `src/kiro.ts` | Posee cleanup de terminales ACP internos, separado del proceso ACP principal | **No ampliar en este bugfix**; evitar mezclar dos contratos de procesos | Tests existentes de herramientas ACP; revisión manual del alcance |
| `scripts/run-tests.mjs` | Harness del repositorio | Compila TypeScript a directorio temporal y ejecuta todos los `.test.mjs` con loader Node/Bun | **Reutilizar** para regresión; no introducir runner nuevo | `node scripts/run-tests.mjs` |
| `tests/kiro-stream.test.mjs` | Pruebas de integración local del stream | Ya crea logger stub, modelo, fetch falso y consume stream | **Extender** con la reproducción ACP | Suite completa y prueba focalizada |
| Dependencias nuevas | `package.json` | No necesarias | **No crear** | `npm run check`, `npm pack --dry-run` |

## Evidencia
1. **E-001 — documentación oficial, verificada** (`bd4c6a51-e912-432c-ba0c-6613e8d5fe7c`): Node documenta `spawn()` como API asíncrona que devuelve un `ChildProcess`/EventEmitter; el proceso debe ser observado mediante sus eventos de ciclo de vida. Fuente: `https://nodejs.org/api/child_process.html`.
2. **E-002 — repositorio, verificada** (`bf010753-4ee2-41cc-8880-4639934b4fdf`): `src/kiro.ts:742-846` crea el proceso ACP, no maneja el `error` del proceso principal, devuelve `false` en `catch` y ejecuta `child.kill()` en `finally`; la reproducción temporal terminó con `spawn ... ENOENT` no capturado.
3. **E-003 — reutilización, verificada** (`3fb03b5d-ea5a-47d7-9d9b-a914b249474b`): el logger, el stream y el harness de pruebas ya existen y cubren el punto de integración; no se necesita dependencia ni infraestructura nueva.
4. **E-004 — estado base, observación verificada en esta ejecución**: typecheck, auditoría de terminal y 25 pruebas existentes pasaron con Node `v26.6.0` antes del cambio.

## Decision ladder de reutilización
1. **Reuse**: usar `DebugLogger.error`, `redactSensitiveString`, `createKiroStream`, el logger stub de `tests/kiro-stream.test.mjs` y `scripts/run-tests.mjs` sin crear APIs nuevas.
2. **Extend**: ampliar `src/kiro.ts` con captura del evento `ChildProcess.error`, el evento de diagnóstico y un helper local de terminación segura; ampliar la prueba existente del stream.
3. **Compose**: componer la promesa de error del proceso con la conexión ACP mediante `Promise.race`; no introducir un supervisor de procesos independiente.
4. **Create**: crear únicamente el caso de regresión dentro del archivo de pruebas existente y los artefactos lifecycle requeridos. No crear paquetes, servicios, loggers ni scripts nuevos.

## Deprecación y compatibilidad
No se deprecara ninguna API pública. El retorno booleano de `executeKiroAcpFallback` permanece interno y compatible; los consumidores siguen recibiendo el error HTTP original cuando ACP falla. El helper de cleanup será privado al módulo y no requiere migración.

## Tokens de diseño y demo
No hay UI ni tokens visuales aplicables. El ejemplo demostrativo es el caso de prueba: HTTP 401 → `cliFallback` → CLI inexistente → evento `acp_fallback_failed` → stream termina con error original, sin excepción global.

## Decisión de investigación
La corrección mínima es: capturar el error del `ChildProcess` ACP, esperar/propagarlo al `catch` del fallback, emitir `logger.error("acp_fallback_failed", ...)` con detalles redactables y encapsular la terminación en una operación segura/idempotente. La prueba debe comprobar que el stream conserva `stopReason: "error"`, no lanza globalmente y registra el evento esperado.

## Fuera de alcance
No modificar la emisión repetida de `runtime-provider-registration`, la precedencia de `requestTimeoutMs`, la validación general del JSON ni la rotación del debug log. Son observaciones de auditoría, pero no son necesarias para el fallo reproducido ni tienen un contrato de cambio confirmado en esta tarea.

STAGE_SUMMARY_COMPLETE
RESULTS: Inventario de reutilización completado; solución acotada a proceso ACP, logger existente y harness de pruebas.
EVIDENCE: Tres registros persistidos (Node docs, implementación/reproducción y componentes reutilizables) más estado base local.
NATIVE_AGENTS: audit-code-deepseek y audit-architecture-glm completados y usados como evidencia independiente.
LOCAL_DELEGATION: BLOCKED; LM Studio local 401 y job remoto fallido al cargar el modelo; no se envió código fuente.
LOCAL_JOBS: Ningún job local completado; runner local rechazó `stdio` antes de ejecutar validaciones.
LOCAL_MODELS: Ninguno completado.
LOCAL_HEALTH: Local requiere `Authorization: Bearer`; remoto `attobeast` respondió pero `qwen3.5-0.8b` no inició.
FALLBACK: Investigación basada en repositorio, documentación oficial y pruebas locales.
OPEN_RISKS: No hay CLI ACP autenticado disponible; no se cubren versiones externas múltiples.
NEXT_GATE: Crear design.md de forma aislada con contratos y estrategia de regresión; después tasks.md.
