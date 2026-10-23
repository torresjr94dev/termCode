# Changelog

Todos los cambios importantes de termCode. El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y las versiones, [SemVer](https://semver.org/lang/es/).

## [Sin publicar]

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
- Rust 1.88 o superior (por `sysinfo`).

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
