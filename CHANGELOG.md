# Changelog

Todos los cambios importantes de termCode. El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y las versiones, [SemVer](https://semver.org/lang/es/).

## [Sin publicar]

### Añadido

- Prueba de Rust que corre Windows PowerShell de verdad a través de ConPTY y comprueba las marcas de prompt, comando, salida y carpeta.
- Las pruebas e2e encuentran Chrome o Edge en Windows.

### Modificado

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
