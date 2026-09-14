# Add Interactive Map Preview for Generated Files

Provide a built-in map preview for generated KML/KMZ files directly within the application, allowing users to toggle individual layers and see the correctly styled geometries without needing to open an external application.

## User Review Required

> [!WARNING]
> **Google Earth Cannot Be Embedded**
> Google officially shut down the embeddable Google Earth API back in 2015. It is technically impossible to embed the actual "Google Earth" application inside another app.

**Alternative Approaches:**
To achieve the exact same functionality (previewing your layers with correct colors and toggles), we can embed a modern map library. There are two main options:

1. **2D Map (OpenLayers or Leaflet)**: A flat map (like Google Maps) that is fast, lightweight, and has excellent support for reading KML styles (colors, borders) and building layer toggles. *(Recommended for speed and simplicity)*
2. **3D Globe (CesiumJS)**: A 3D spinning globe (very similar to Google Earth). It is heavier and requires downloading large libraries, but provides a true 3D Google Earth-like experience.

## Open Questions

> [!IMPORTANT]
> 1. Are you okay with using a 2D map (like Google Maps / OpenLayers) for the preview, or do you strictly need a 3D spinning globe (CesiumJS)?
> 2. Where should this preview live? Should it be a new "Preview" tab next to the "Log" and "Results" tabs, or should it open in a separate popup window when you click on a generated file?

## Proposed Changes

If we proceed with a 2D map preview in a new tab:

### UI & Layout (index.html & styles.css)
- Add a new "Preview" tab next to "Log" and "Results".
- Include a full-screen map container `div`.
- Add a custom "Layers" floating control panel over the map to toggle the folders/layers found in the KMZ.

### Map Rendering (app.js & new map.js)
- Use **OpenLayers** (via CDN or bundled) to render the map.
- When a user clicks "Preview" on a result, the app will read the KML from the generated KMZ file.
- OpenLayers natively understands KML styles (colors, stroke widths). We will parse the `<Folder>` names in the KML to populate the layer toggle checkboxes.

## Verification Plan

- Generate a complex KMZ with multiple selected layers (e.g., Power lines, Settlements).
- Open the Preview tab.
- Verify that the map renders the polygons/lines with the exact colors they have in Google Earth.
- Verify that toggling the layers in the UI successfully shows/hides the respective data.
