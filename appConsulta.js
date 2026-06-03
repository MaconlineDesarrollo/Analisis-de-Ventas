const express = require('express');
const path    = require('path');
const serviceConsulta = require('./serviceConsulta');

const app  = express();
const port = 6005;

// Sirve archivos estáticos (CSS, JS, etc.) desde el mismo directorio
app.use(express.static(__dirname));

// ─── Página principal ────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'consultaIndex.html'));
});

// ─── API de consulta ─────────────────────────────────────────────────────────
// GET /api/consultar?tipo=ITEM&desde=2025-01-01&hasta=2025-01-31
// GET /api/consultar?tipo=QD&desde=2025-01-01&hasta=2025-01-31
app.get('/api/consultar', async (req, res) => {
    const { tipo, desde, hasta } = req.query;

    // Validaciones básicas
    if (!tipo || !desde || !hasta) {
        return res.status(400).json({
            error: 'Se requieren los parámetros: tipo, desde, hasta'
        });
    }
    if (!['ITEM', 'QD'].includes(tipo.toUpperCase())) {
        return res.status(400).json({
            error: 'El parámetro tipo debe ser ITEM o QD'
        });
    }
    if (desde > hasta) {
        return res.status(400).json({
            error: 'La fecha "desde" no puede ser mayor que "hasta"'
        });
    }

    try {
        let rows;
        if (tipo.toUpperCase() === 'ITEM') {
            rows = await serviceConsulta.consultarITEM(desde, hasta);
        } else {
            rows = await serviceConsulta.consultarQD(desde, hasta);
        }

        return res.json({
            tipo: tipo.toUpperCase(),
            desde,
            hasta,
            total: rows.length,
            data: rows
        });

    } catch (err) {
        console.error('Error en consulta:', err.message);
        return res.status(500).json({
            error: 'Error al ejecutar la consulta: ' + err.message
        });
    }
});

// ─── Inicio del servidor ─────────────────────────────────────────────────────
app.listen(port, () => {
    console.log(`Servidor de consultas en: http://localhost:${port}`);
});
