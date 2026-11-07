<div align="center">

# Google Maps Scraper — Chrome Extension

**Prospección local más simple para freelancers.** Encuentra negocios en Google Maps, revisa y limpia los datos, y expórtalos a CSV desde Chrome.

[Descargar extensión](https://github.com/sebastianbocek/Google-Maps-Scraper---Extension-Chrome/releases/latest/download/google-maps-scraper-extension.zip) · [Ver video de muestra](https://github.com/sebastianbocek/Google-Maps-Scraper---Extension-Chrome/releases/latest/download/demo.mp4)

</div>

## Demo

![Demostración de Google Maps Scraper](assets/demo.gif)

[Ver o descargar el video MP4](assets/demo.mp4)

## Qué hace

- Extrae fichas de negocios visibles en Google Maps y Google Local.
- Guarda nombre, teléfono, valoración, categoría, sitio web y enlace de WhatsApp cuando están disponibles.
- Permite iniciar, detener y continuar la extracción desde el panel de la extensión.
- Limpia la exportación antes de descargar: excluye categorías o ciudades y permite elegir una ubicación objetivo.
- Descarga los resultados como archivo `.csv`, listo para revisar en una hoja de cálculo o importar a un CRM.
- Abre WhatsApp Web para un teléfono con `Alt` + clic sobre el número en Google Maps.
- Procesa y guarda los datos localmente en Chrome; no los envía a un servidor externo.

> La cantidad y calidad de resultados dependen de lo que Google Maps cargue y muestre. La herramienta no garantiza que un teléfono tenga WhatsApp ni que cada ficha incluya todos los campos.

## Instalación en Chrome

1. [Descarga la extensión en ZIP](https://github.com/sebastianbocek/Google-Maps-Scraper---Extension-Chrome/releases/latest/download/google-maps-scraper-extension.zip) y descomprímela en una carpeta.
2. Abre `chrome://extensions/` en Chrome.
3. Activa **Modo desarrollador** en la parte superior derecha.
4. Haz clic en **Cargar descomprimida**.
5. Selecciona la carpeta descomprimida que contiene `manifest.json`.
6. Abre [Google Maps](https://www.google.com/maps) y realiza una búsqueda, por ejemplo: “cafeterías en Palermo”.
7. Haz clic en el icono de la extensión y luego en **Iniciar extracción**. Deja que Google Maps cargue los resultados mientras la extensión recorre las fichas.
8. Revisa las categorías y ubicaciones en **Limpiar CSV**. Excluye lo que no quieras exportar o elige una ubicación objetivo.
9. Haz clic en **Descargar CSV**.

**Límite de fichas:** `0` deja que la extracción continúe hasta que Google Maps no cargue más resultados nuevos. No equivale a todos los negocios existentes en la zona.

## Cómo ayuda en la prospección freelance

Para freelancers de marketing, diseño web, SEO, fotografía y servicios comerciales, el directorio de negocios puede ser un punto de partida para investigar prospectos locales. La extracción reduce la carga de copiar datos ficha por ficha; la limpieza ayuda a enfocar la lista por rubro y zona, y el CSV facilita organizar la investigación, priorizar contactos y preparar mensajes personalizados.

Usa los datos para investigación y contacto responsable: verifica cada negocio y respeta las leyes aplicables, las condiciones de las plataformas y las preferencias de contacto. La extensión no envía mensajes automáticamente.

## Actualizar la extensión

Si ya tienes una versión instalada, conserva la misma carpeta de instalación: reemplaza sus archivos por los de la nueva versión, vuelve a `chrome://extensions/`, pulsa **Recargar** en la tarjeta de la extensión y actualiza la pestaña de Google Maps. Así Chrome puede conservar la identidad y los datos locales de la instalación.

## Archivos del proyecto

- `manifest.json`: configuración de la extensión Manifest V3.
- `popup.html`, `popup.css`, `popup.js`: panel, controles y limpieza de exportación.
- `content.js`: lectura y extracción de fichas desde Google.
- `data_utils.js`, `quick_whatsapp.js`: utilidades de datos y acceso rápido a WhatsApp.
- `background.js`: servicio en segundo plano y descarga.
- `assets/demo.gif`, `assets/demo.mp4`: muestra animada y video original.

## Privacidad y límites

La extensión no usa un backend y guarda los resultados en el almacenamiento local de Chrome. Google puede cambiar su interfaz, lo que puede afectar la extracción. Los resultados pueden incluir datos incompletos o negocios de localidades cercanas; comprueba la lista antes de contactar o exportar.

## Instalación manual desde el código

Clona este repositorio, abre `chrome://extensions/`, activa **Modo desarrollador** y selecciona **Cargar descomprimida** para la carpeta del proyecto que contiene `manifest.json`.

