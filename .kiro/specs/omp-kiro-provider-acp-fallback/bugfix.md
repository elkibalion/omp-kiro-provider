# Bugfix: ACP fallback no debe derribar el stream ante un CLI inválido

## Alcance
Corregir el fallback `kiro-cli acp` cuando el proceso hijo no puede arrancar o termina con error. El cambio queda limitado a `src/kiro.ts` y a pruebas de regresión del fallback. No se modifican la precedencia OAuth, las emisiones de registro runtime ni el tamaño del debug log porque no fueron necesarios para reproducir el fallo funcional y las emisiones repetidas están cubiertas como contrato existente.

## Síntoma reproducido
- Estado inicial: árbol Git limpio; typecheck, auditoría de terminal y 25 pruebas pasaron.
- Configuración de reproducción: respuesta HTTP 401 para activar `cliFallback`, `cliFallback: true` y `kiroCliPath: "/definitely/missing/kiro-cli"`.
- Comando: `~/.kiro/scripts/kiro-timeout.sh 240 node scripts/run-tests.mjs` con un fixture temporal que invoca `createKiroStream`.
- Resultado observado antes del cambio: excepción no capturada y terminación de la suite: `Error: spawn /definitely/missing/kiro-cli ENOENT`.
- Causa confirmada: `executeKiroAcpFallback` no registra el evento `error` del `ChildProcess`; su `catch` devuelve `false` sin diagnóstico y el `finally` ejecuta `child.kill()` sin una función de terminación idempotente.

## Objetivo
Un fallo de arranque, transporte o terminación del ACP debe degradar al error HTTP original del proveedor, registrar un diagnóstico seguro y no producir una excepción global ni dejar un proceso hijo activo.

## Criterios de aceptación
- **AC-001**: Un `kiroCliPath` inexistente durante un fallback ACP no genera una excepción no capturada; el stream termina con `stopReason: "error"`.
- **AC-002**: El fallback fallido emite `acp_fallback_failed` con modelo, ruta del CLI y error; los detalles se entregan al `DebugLogger` para mantener la redacción existente.
- **AC-003**: El error de la petición original sigue siendo el `errorMessage` funcional cuando ACP no logra arrancar; el fallback no convierte un fallo de auth en éxito falso.
- **AC-004**: El cleanup del proceso ACP es seguro si el proceso ya terminó, emitió `error` o no llegó a arrancar; no debe lanzar una segunda excepción.
- **AC-005**: La suite existente y las pruebas nuevas cubren el camino feliz del fallback sin romper los contratos actuales de stream, auth, headers y registro runtime.
- **AC-006**: Typecheck, lint/auditoría, pruebas y empaquetado seco siguen pasando en Node 20+; la ejecución disponible del entorno actual usa Node 26.6.0.

## Riesgos y límites
- No se puede verificar un ACP real autenticado en este entorno sin credenciales y sin instalar/alterar el CLI.
- El plano LM Studio local quedó bloqueado por HTTP 401 y el job remoto seleccionado falló al cargar el modelo; se usará delegación nativa independiente para la revisión y no se enviará código privado a servicios externos.
- No se autoriza commit, push, publicación ni cambios fuera del repositorio.

STAGE_SUMMARY_COMPLETE
RESULTS: Reproducción confirmada de `spawn ENOENT` no capturado en ACP fallback; alcance reducido a manejo de proceso, diagnóstico y regresión.
EVIDENCE: Base typecheck/auditoría/tests pasan; fixture temporal falló con excepción global `spawn /definitely/missing/kiro-cli ENOENT`.
NATIVE_AGENTS: audit-code-deepseek y audit-architecture-glm completados; ambos señalaron pérdida de error y cleanup inseguro.
LOCAL_DELEGATION: BLOCKED; local LM Studio respondió 401 por token ausente; job remoto `local-review-1` falló al arrancar `qwen3.5-0.8b` con error del engine.
LOCAL_JOBS: Ningún job local completado; los jobs de validación del runner fallaron por rechazo interno de `stdio`.
LOCAL_MODELS: Ninguno completado.
LOCAL_HEALTH: máquina local no disponible por autenticación; `attobeast` sano pero el modelo seleccionado no pudo cargar.
FALLBACK: Revisión nativa y pruebas locales del repositorio; no se usó código fuente en servicios externos.
OPEN_RISKS: ACP real autenticado, comportamiento de versiones externas de `kiro-cli` y ausencia de credenciales no verificados.
NEXT_GATE: Completar research.md con reutilización y evidencia, luego design.md/tasks.md antes de implementar.
