# Tasks: contratos ejecutables del bugfix ACP

## Gate de ejecución
El trabajo queda limitado al fallback ACP; los dos MCP solicitados se mantienen como proyectos separados y pospuestos. Los agentes, modelos y planos coinciden con el registro generado.

LISTO_PARA_EXECUTION

## TASK-001: Manejo seguro del proceso ACP
- Status: pending
- Objective: Evitar la excepción global de ChildProcess, convertir errores de spawn/transporte en fallos controlados y registrar acp_fallback_failed mediante el logger existente.
- Agent: developer
- Model: qwen3-coder-next
- Plane: remote
- Rationale: Agente registrado para implementación TypeScript con acceso a lectura/escritura y shell; el cambio es local a Node y no requiere modelo premium.
- Dependencies: none
- Inputs: src/kiro.ts, contrato de DebugLogger, reproducción spawn ENOENT, AC-001..AC-004.
- Outputs: captura de child error integrada en la conexión ACP, log redactable, cleanup privado seguro y diff acotado.
- Files: src/kiro.ts
- Acceptance Criteria: AC-001, AC-002, AC-003, AC-004
- Verification: npx tsc --noEmit; prueba focalizada de CLI inexistente; inspección de diff sin credenciales.
- Risk: medium; una carrera mal compuesta puede dejar una promesa rechazada o alterar el camino ACP exitoso; mitigar con Promise.race manejado y regresión del TASK-002.

## TASK-002: Regresión del stream ACP
- Status: pending
- Objective: Añadir una prueba reproducible que demuestre que CLI inexistente no lanza globalmente, conserva el error HTTP y registra el evento esperado.
- Agent: backend-api-deepseek
- Model: deepseek-3.2
- Plane: remote
- Rationale: Agente registrado para Node/TypeScript y pruebas de runtime; segundo modelo para desafiar el contrato funcional sin usar premium.
- Dependencies: TASK-001
- Inputs: tests/kiro-stream.test.mjs, helpers logger/model/fetch existentes, AC-001, AC-003, AC-005, AC-006.
- Outputs: prueba de regresión en el archivo existente, sin fixture permanente adicional ni credenciales.
- Files: tests/kiro-stream.test.mjs
- Acceptance Criteria: AC-001, AC-003, AC-005, AC-006
- Verification: node scripts/run-tests.mjs; el caso debe reproducir el fallo en la implementación vieja y pasar con la nueva; verificar restauración de globalThis.fetch.
- Risk: medium; el test podría depender de timing del proceso; mitigar con ruta inexistente determinista y consumo completo del stream.

## TASK-003: Verificación independiente y QA
- Status: pending
- Objective: Revisar el diff y ejecutar comprobaciones multidimensionales sin que el implementador se autoapruebe todos los criterios.
- Agent: reviewer-kiro
- Model: claude-haiku-4.5
- Plane: remote
- Rationale: Agente registrado de revisión de código, económico y adecuado para verificar contratos, errores y regresiones después de la implementación.
- Dependencies: TASK-001, TASK-002
- Inputs: diff de src/kiro.ts y tests/kiro-stream.test.mjs, AC-001..AC-006, resultados de typecheck/test/lint/package dry-run.
- Outputs: dictamen independiente PASS o NEEDS_CHANGES con rutas/líneas, riesgos restantes y comprobaciones faltantes; no edita producción.
- Files: src/kiro.ts, tests/kiro-stream.test.mjs, scripts, artefactos lifecycle
- Acceptance Criteria: AC-001, AC-002, AC-003, AC-004, AC-005, AC-006
- Verification: revisión de diff, typecheck, lint, suite, npm pack --dry-run, recuperación del error y chequeo de secretos; QA visual not_applicable por cambio backend/runtime sin UI.
- Risk: medium; no hay CLI ACP autenticado disponible; declarar esa limitación sin convertirla en falso PASS.

## Acceptance Criteria
- AC-001: Un kiroCliPath inexistente durante un fallback ACP no genera excepción no capturada y el stream termina con stopReason error.
- AC-002: Un fallback ACP fallido emite acp_fallback_failed con modelo, CLI y error a través del logger redactable.
- AC-003: Cuando ACP no arranca, errorMessage conserva el error de la petición HTTP original y no se produce éxito falso.
- AC-004: El cleanup del proceso ACP es seguro si el proceso ya terminó, emitió error o no llegó a arrancar.
- AC-005: La suite existente y la regresión nueva pasan sin romper stream, auth, headers ni registro runtime.
- AC-006: Typecheck, lint/auditoría, pruebas y empaquetado seco pasan en Node 20+; la ejecución disponible usa Node 26.6.0.

STAGE_SUMMARY_COMPLETE
RESULTS: Contrato reformateado al parser local con tres tareas, dependencias acíclicas, agentes registrados y AC definidos.
EVIDENCE: task-contract-gate.py y agents-registry.json inspeccionados; TASK-001..003 cumplen campos requeridos y modelos exactos.
NATIVE_AGENTS: Auditorías iniciales completadas; TASK-003 reserva reviewer-kiro para revisión independiente.
LOCAL_DELEGATION: BLOCKED; LM Studio local 401 y job remoto fallido al cargar modelo.
LOCAL_JOBS: Ningún job local completado; runner de jobs rechazó stdio.
LOCAL_MODELS: Ninguno completado.
LOCAL_HEALTH: LM Studio local exige Bearer token; remoto attobeast no cargó el modelo seleccionado.
FALLBACK: Agentes nativos económicos y validación directa local.
OPEN_RISKS: No existe prueba ACP autenticada real; se valida spawn failure y contrato de stream.
NEXT_GATE: Registrar execution.md y ejecutar validaciones; los MCP quedan para otro proyecto.
