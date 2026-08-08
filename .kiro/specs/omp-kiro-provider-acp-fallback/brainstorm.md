# Brainstorm: fallback ACP del proveedor OMP

## Problema inicial
Cuando la petición HTTP de Kiro falla por autenticación y se activa `cliFallback`, el proveedor intenta iniciar `kiro-cli acp`. Si la ruta configurada no existe, el proceso hijo emite `error` sin listener y el runtime puede terminar con una excepción no capturada en lugar de devolver un error normal al consumidor.

## Hipótesis verificadas
1. El fallback no captura de forma observable los errores de arranque del proceso hijo.
2. El `catch` actual no deja diagnóstico específico del fallback.
3. El cleanup debe ser idempotente cuando el proceso ya terminó o no llegó a arrancar.

## Hipótesis no incluidas
La precedencia de timeouts OAuth, la emisión repetida del registro runtime y la rotación del debug log requieren decisiones de contrato independientes y no son necesarias para corregir el fallo reproducido.

## Dirección propuesta
Reutilizar `DebugLogger`, el stream de errores existente y las pruebas actuales de `createKiroStream`; añadir manejo seguro del evento `error`, registrar un evento `acp_fallback_failed` sin secretos y proteger el cleanup del proceso. Validar primero con un CLI inexistente y después con la suite completa.

LISTO_PARA_SPEC

STAGE_SUMMARY_COMPLETE
RESULTS: Problema y dirección mínima de solución identificados; no se modificó código de producción.
EVIDENCE: Reproducción temporal obtuvo `spawn /definitely/missing/kiro-cli ENOENT` como excepción no capturada.
NATIVE_AGENTS: Dos auditorías nativas completadas previamente; sus resultados convergen en ACP error loss y cleanup.
LOCAL_DELEGATION: BLOCKED; LM Studio local exige token y el job remoto no pudo cargar el modelo seleccionado.
LOCAL_JOBS: Ningún job local completado.
LOCAL_MODELS: Ninguno completado.
LOCAL_HEALTH: Local HTTP 401; remoto `attobeast` disponible pero el modelo de revisión falló al iniciar.
FALLBACK: Evidencia del repositorio, reproducción local y revisiones nativas.
OPEN_RISKS: No se probó ACP autenticado real ni múltiples versiones de `kiro-cli`.
NEXT_GATE: Crear `bugfix.md` de forma aislada y documentar alcance y AC-NNN.
