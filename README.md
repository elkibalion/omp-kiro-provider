# omp-kiro-provider

Extensión nativa de [Oh My Pi](https://github.com/canstralien/oh-my-pi) que
registra Kiro como proveedor de modelos con streaming, OAuth y soporte de
herramientas.

La implementación usa el endpoint compatible con CodeWhisperer de Kiro y
conserva la atribución MIT del proyecto original
[`pi-kiro-provider`](https://github.com/MasuRii/pi-kiro-provider).

- **ID del proveedor:** `kiro`
- **Modelos:** `kiro/auto`, Claude, DeepSeek, MiniMax, GLM y Qwen disponibles
  según la cuenta de Kiro
- **Autenticación:** AWS Builder ID, Google y GitHub

## Instalación

Cuando el paquete esté publicado:

```bash
omp plugin install omp-kiro-provider
```

Para probar la copia local:

```bash
omp plugin link ~/omp-plugins/omp-kiro-provider
```

Reinicia OMP después de instalar o enlazar el plugin.

## Autenticación

Dentro de OMP:

```text
/login kiro
```

Selecciona AWS Builder ID, Google o GitHub y completa el flujo en el navegador.
Después selecciona un modelo como:

```text
kiro/auto
```

La extensión registra OAuth mediante el registro de proveedores de OMP. Las
credenciales se guardan en el almacén de autenticación de OMP, no en el código
del plugin.

Si el endpoint directo de CodeWhisperer responde `401`/`403` —por ejemplo,
cuando Kiro ha rotado el perfil IAM— la extensión usa automáticamente el
transporte ACP oficial de `kiro-cli`. Este fallback consume la suscripción
activa de Kiro y no extrae ni almacena tokens privados.

```bash
kiro-cli login
kiro-cli --help
```

El CLI debe estar autenticado con la cuenta de Kiro que quieres usar. Puedes
desactivar el fallback con `"cliFallback": false`.

## Configuración opcional

La extensión funciona con valores predeterminados. Para personalizarla:

```bash
cp config/config.example.json config.json
```

Para una instalación local enlazada, coloca `config.json` en:

```text
~/omp-plugins/omp-kiro-provider/config.json
```

Para una instalación npm, usa un archivo externo y define:

```bash
export OMP_KIRO_CONFIG="$HOME/.config/omp/kiro.json"
```

Ejemplo mínimo:

```json
{
  "enabled": true,
  "debug": false,
  "providerId": "kiro",
  "displayName": "Kiro",
  "upstreamUrl": "https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse",
  "endpoint": "codewhisperer",
  "cliFallback": true,
  "kiroCliPath": "kiro-cli",
  "requestTimeoutMs": 600000
}
```

Opciones adicionales:

| Opción | Descripción |
| --- | --- |
| `upstreamUrl` | Endpoint de streaming directo |
| `endpoint` | `codewhisperer` o `amazonq` |
| `cliFallback` | Usa `kiro-cli acp` si el endpoint directo devuelve `401`/`403` |
| `kiroCliPath` | Ruta del ejecutable `kiro-cli` |
| `kiroCliAgent` | Perfil pasado a `kiro-cli acp --agent`; útil para evitar hooks globales del CLI |
| `requestTimeoutMs` | Timeout de streaming y OAuth |
| `profileArn` | ARN opcional del perfil Kiro |
| `headers` | Headers adicionales no relacionados con autorización |
| `models` | Reemplaza la lista integrada de modelos |
| `modelDefaults` | Valores predeterminados de los modelos |

Los headers `Authorization` configurados manualmente se descartan
intencionadamente; la autenticación la controla OAuth.

## Verificación local

```bash
npm install
npm run check
npm run package:dry-run
```

## Nota de seguridad

Este plugin realiza OAuth contra servicios de Kiro y envía prompts, resultados
de herramientas y metadatos de sesión a los endpoints de Kiro. Revisa el código
y usa una cuenta adecuada antes de instalarlo en un entorno sensible.

Los endpoints de Kiro pueden cambiar sin aviso porque no forman parte de una
API pública OpenAI-compatible.

## Licencia

MIT
