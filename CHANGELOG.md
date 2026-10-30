# Changelog

Todos los cambios importantes de termCode. El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y las versiones, [SemVer](https://semver.org/lang/es/).

## [Sin publicar]

## [0.6.0] - 2026-10-29

### Añadido

- Shift+Enter en el prompt de zsh es un salto de línea: escribes un comando de varias líneas sin la `\` al final y Enter lo ejecuta entero, igual que Shift+Enter en Claude Code y Codex. Funciona también en modo vi y, si ya tenías Shift+Enter ligado a algo en tu `.zshrc`, manda lo tuyo. Necesita la integración con zsh; con un programa corriendo (nano, vim, ssh) y en otras shells, Shift+Enter sigue siendo Enter.

## [0.5.0] - 2026-10-27

### Añadido

- Mover paneles divididos: arrastra un panel por su barra hasta otro. En un borde lo pega de ese lado (arriba, abajo, a la izquierda o a la derecha) y al centro los intercambia; mientras arrastras se ve dónde va a caer, y Esc lo cancela. Es la misma terminal en otro sitio: no se reinicia, no pierde su historial y lo que corre sigue corriendo. Con el teclado, «Mover panel arriba / abajo / a la izquierda / a la derecha» en la paleta lo cambia por su vecino.
- Un `claude` o `codex` que escribes a mano en una shell tiene la misma barra que uno lanzado desde termCode (modelo, contexto libre, terminal acoplada), igual que la pestaña, la barra de estado, la barra lateral y Mission Control. Se reconoce en cuanto la shell lo ejecuta, sin esperar a que el agente se anuncie por OSC 7501 (Codex y los Claude Code viejos no lo hacen). `claude -p`, `codex exec` y los subcomandos (`claude mcp`, `codex login`…) no cuentan.
- En zsh con la integración, un `claude` escrito a mano recibe el `--settings` de termCode (statusLine y hooks) y, si está activado, el MCP de lectura de paneles. Así reporta su modelo y contexto y sus permisos llegan a la bandeja. Tus alias siguen funcionando, si ya tienes una función `claude` se respeta la tuya, y `-p`, los subcomandos y un `--settings` propio pasan tal cual.

### Modificado

- La tarjeta de bienvenida se convierte en una barra fija arriba de cada terminal: el logo, la carpeta y la rama, y Claude Code y Codex para abrirlos ahí mismo. Ya no se va con el scroll ni con `clear`, ocupa 32 px en vez de ~160 y no repite la cuota ni ⌘K, que ya están en la cabecera. Cuando corre un agente, la misma barra muestra su modelo y su contexto. Se apaga en Ajustes → Terminal → «Barra en cada terminal»; si tenías apagada la bienvenida, la barra empieza apagada.
- Claude Code y Codex en la barra de una shell se abren en ese mismo panel (se teclea `claude` o `codex` en la shell, y al salir vuelves a ella con tu carpeta, tu entorno y tu historial), ya no en una división. Si algo está corriendo, se abren junto al panel y se avisa por qué. «Junto al panel» sigue en la paleta y en la barra lateral.

## [0.4.0] - 2026-10-27

### Añadido

- Estado de los agentes por OSC 7501 (Program Status Protocol): termCode contesta la consulta con la que Claude Code (2.1.295 o posterior) pregunta si la terminal lo soporta, y desde ahí el agente dice él mismo si trabaja, te necesita (permiso, pregunta, login) o terminó. Llega por el PTY de su propio panel, así que no puede caer en otro, y manda sobre los hooks, que quedan para Windows y versiones anteriores.
- Un `claude` o `codex` escrito a mano en una shell cuenta como agente en Mission Control, la barra lateral y la barra de estado en cuanto se anuncia por OSC 7501.
- Shift+Enter en un agente es un salto de línea (se envía Ctrl+J, que Claude Code y Codex leen así en cualquier terminal). En una shell sigue siendo Enter.
- Mission Control dice en la cabecera cuántos agentes te necesitan y cuántos trabajan, y en la tarjeta de uno que espera permiso, que está en la bandeja.

### Corregido

- «Te necesita» se quedaba pegado en agentes que ya habían terminado: Claude Code avisa (`Notification` tipo `idle_prompt`) unos 60 s después de cada turno, y termCode lo tomaba como una petición. Ahora ese aviso solo confirma que el agente está quieto, y únicamente los permisos y diálogos cuentan como "te necesita".
- Al ir al panel de un agente bloqueado la campana se apagaba y al salir volvía a encenderse, y Mission Control mostraba "te necesita" aunque el agente ya trabajaba: una marca de atención vieja ganaba al estado real. Ahora manda lo que el agente reporta y la marca se retira en cuanto deja de necesitarte.
- Un permiso aprobado en el propio panel dejaba al agente en "te necesita" hasta la siguiente herramienta (hook `PostToolUse`); una pregunta (`AskUserQuestion`) o un plan por aprobar ahora sí cuentan como "te necesita"; al cerrar la sesión (`SessionEnd`) el agente deja de verse trabajando.
- Si un ssh se cortaba (`Broken pipe`) con Claude Code o vim del otro lado, el ratón quedaba activado y cada movimiento escribía `35;88;22M35;87;22M…` en el prompt. Cuando la shell vuelve a su prompt, termCode apaga el ratón y el foco que dejó encendidos un programa que ya no está, y vuelve a mostrar el cursor.
- A pantalla completa en macOS quedaba el hueco de los semáforos a la izquierda del header (y de Mission Control y la vista general).
- Las imágenes sixel no se veían en la app: la política de seguridad bloqueaba el WebAssembly de su decodificador (`'wasm-unsafe-eval'`, que no permite `eval` de JavaScript).
- Con broadcast activo, las respuestas automáticas de una terminal (posición del cursor, `CSI c`, foco) se escribían en todos los paneles: ahora solo se difunde lo que tecleas en el panel con el foco.
- Las escrituras al PTY van en orden: dos envíos seguidos podían ejecutarse en paralelo en el backend y cruzarse.

## [0.3.0] - 2026-10-23

### Añadido

- Versión para Linux (x86_64 y ARM64): cada release trae AppImage, `.deb` y `.rpm`, compilados en Ubuntu 22.04 para que corran desde glibc 2.35 (Ubuntu 22.04, Debian 12, Fedora 36). La ventana lleva el marco de tu escritorio y se pinta opaca; con el driver propietario de NVIDIA, WebKitGTK usa su renderizador sin DMA-BUF para no dejar la ventana en blanco. CI compila, pasa clippy y corre los tests de Rust en Linux.
- La salida completa de un comando en el visor (clic en el comando de la barra de estado, en su marca del margen o desde la paleta): se lee entera y se busca con ⌘F.
- «Explicar este error»: en un comando que falló, manda el comando, su carpeta y el final de su salida al agente (o abre Claude junto al panel con ese mensaje).
- Terminal acoplada al agente (`⌘L` o el botón «terminal» de su cabecera): una shell en la carpeta del agente, abajo, sin dividir el panel; se pliega sin perder la shell.
- Elegir shell: menú junto al `+` de las pestañas con las shells instaladas (zsh, bash, fish, nu, PowerShell…), la predeterminada en Ajustes, y las divisiones heredan la de su panel.
- Servidores SSH en la barra lateral: los `Host` de tu `~/.ssh/config` y los que agregues (nombre, host, puerto, usuario, llave). Un clic abre una pestaña conectada. Nunca se guardan contraseñas.
- Puertos en escucha de cada panel (`:3000 ↗`), que abren su página en el navegador (macOS y Linux).
- Al reabrir termCode, cada terminal vuelve con sus últimas 1000 líneas (desactivable en Ajustes).
- Workspaces por repo (`.termcode.json`): los paneles del proyecto (servidor, tests, agente) en una pestaña. La primera vez, y cada vez que el archivo cambia, muestra los comandos exactos y pide confianza.
- Detalle del sistema al hacer clic en CPU/GPU/RAM de la barra de estado: uso por núcleo, carga, memoria disponible y swap, y los procesos que más usan (por memoria o CPU), con la opción de terminar uno tuyo.
- El panel de proyecto avisa cuando `git status` no responde y, si el repo está en iCloud Drive (u otra nube), dice por qué.
- Monitor del sistema en la barra lateral: CPU y GPU con su tendencia de 2 minutos, RAM con la presión de memoria de macOS y swap, y los procesos que más memoria usan. Con la barra lateral oculta, CPU, GPU y RAM van en la barra de estado. Solo mide mientras se ve.
- Carpetas recientes y fijadas en la barra lateral: un clic hace `cd` en la terminal activa; al pasar el cursor, abren una shell, Claude Code o Codex ahí.
- Contexto de Codex por panel (modelo y cuánto queda), leído del rollout que el propio proceso de Codex tiene abierto, con la misma cuenta que muestra Codex.
- La barra de estado dice cuánto contexto le queda al agente del panel activo.
- Explorador de archivos: doble clic en una carpeta hace `cd` en la terminal activa, migas de pan clicables, botón para subir y la carpeta actual marcada; el árbol se despliega hasta donde está la terminal.

### Modificado

- Cada sesión de la barra lateral muestra su carpeta (y la rama del repo), el último comando con su resultado y, en los agentes, una barra con el contexto libre. Las pestañas y la cabecera de cada panel también dicen en qué carpeta están.
- El panel de proyecto empieza abierto en Archivos; plegado queda como un riel con sus vistas, y su estado se guarda con la sesión.
- El lanzador de la barra lateral ocupa una sola fila; las secciones Carpetas y Sistema se pliegan y lo recuerdan.
- Rust 1.90 o superior: lo piden Tauri y sus plugins.

### Corregido

- La tarjeta de bienvenida tapaba las primeras líneas de la salida: el `clear` de macOS manda `ESC[3J` antes de borrar la pantalla y la tarjeta se ponía antes del borrado; además aparecía cuando un programa (Vite, `tsc -w`, jest) limpiaba la pantalla. Ahora va solo tras un `clear` que escribiste, después del borrado.
- El panel de proyecto no cambiaba de carpeta al pasar a un panel de agente mientras un `git status` lento seguía en curso: cambiar de carpeta ya no espera a git, y un repo que no responde se reintenta con espera creciente en vez de cada 2,5 s.
- La tarjeta de bienvenida de un panel que se angosta (al dividir) pasa a la compacta, igual que la del panel nuevo, en vez de apretar logo y botones.
- Las acciones de las carpetas de la barra lateral se encimaban con la ruta.
- Con el visor abierto, cambiar de pestaña devolvía el teclado a la terminal de abajo (Esc dejaba de cerrar el visor).
- Limpiar la pantalla con `Ctrl+L` (o cualquier `ESC[2J` sin `ESC[3J`) borraba la última pantalla de salida en vez de subirla al historial: un traceback largo quedaba con un hueco al hacer scroll. Ahora se conserva, como en Terminal.app e iTerm2 (`clear` sigue borrando todo).

## [0.2.0] - 2026-10-22

### Añadido

- Windows: la barra de pestañas es la barra de título (sin el marco del sistema), con los botones de ventana de Windows y Mica en Windows 11.
- Campana en el header con cuántos paneles te esperan; lleva al primero, como `⌘J`.
- Engrane de Ajustes en el header.
- Prueba de Rust que corre Windows PowerShell de verdad a través de ConPTY y comprueba las marcas de prompt, comando, salida y carpeta.
- Las pruebas e2e encuentran Chrome o Edge en Windows.

### Modificado

- Las pestañas muestran el ícono de lo que corre (shell, Claude Code, Codex) en el color de su proyecto, en vez del número y el punto, y se encogen antes de desbordarse.
- La tarjeta de bienvenida usa la variante compacta en paneles de menos de 560 px y, si se angosta después de abrirse, se queda con lo esencial.
- Fuera de macOS, los atajos con puntuación o dígitos (`Ajustes`, tamaño de letra) se reconocen por la tecla física: con Shift pulsado, el carácter depende del teclado.
- Los paneles y pestañas de Windows muestran `powershell` o el proyecto en vez de `Administrador: C:\Windows\…\powershell.exe`.
- La tarjeta de bienvenida en un panel angosto muestra un solo atajo fuera de macOS, para que los atajos largos de Windows no la recorten.

### Corregido

- Windows: una terminal podía quedarse en blanco al abrirse. ConPTY pregunta la posición del cursor y no muestra nada hasta recibir la respuesta, y esa respuesta se perdía si xterm contestaba antes de conocer el id de la sesión.
- Windows: `Ctrl+C` copia si hay selección, `Ctrl+V` pega y `Ctrl+Shift+C/V` también, como en Windows Terminal; antes `Ctrl+V` mandaba `^V`.
- Windows: xterm sabe que la PTY es ConPTY y en qué build de Windows corre, para no duplicar líneas al agrandar un panel ni reacomodarlas donde ConPTY no lo hace.
- Windows: `Ctrl+C` volvía a no interrumpir nada si termCode se abría desde un proceso que ignora Ctrl+C (ese atributo se hereda).
- Recargar la vista dejaba vivas las shells y los agentes anteriores sin nadie que los leyera; ahora se cierran. En Windows se bloquean además `F5`, `Ctrl+R`, `Ctrl+Shift+R` y `Ctrl+P` fuera de la terminal.
- Windows: `Ctrl`-clic en una ruta del proyecto abre el visor, y *Enviar revisión* encuentra al agente aunque su carpeta use otras mayúsculas o `\`.
