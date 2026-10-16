const router = require('express').Router();
const pool = require('../db');
const { authenticateToken } = require('../middleware/auth');
const fs = require('fs');
const multer = require('multer');
const path = require('path');

// Configurar multer para manejar archivos (imágenes del presupuesto)
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, '../uploads/temp');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
  fileFilter: function (req, file, cb) {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten archivos de imagen'));
    }
  }
});

// pdfGenerator es opcional: si el archivo no está todavía, el server bootea igual
// y solo el endpoint /generar-pdf devuelve 501 hasta que lo agregues.
let generarPresupuestoPDF = null;
try {
  ({ generarPresupuestoPDF } = require('../services/pdfGenerator'));
} catch (e) {
  console.warn('⚠️ services/pdfGenerator no disponible — /presupuestos/generar-pdf deshabilitado:', e.message);
}

// Función para verificar si es Owner
async function isOwner(userId) {
  try {
    const [users] = await pool.execute('SELECT role FROM users WHERE id = ?', [userId]);
    if (users.length === 0) return false;
    return ['owner', 'dueño'].includes(users[0].role);
  } catch (error) {
    console.error('Error checking owner:', error);
    return false;
  }
}

// GET todas las plantillas (todos los usuarios autenticados pueden ver)
router.get('/', authenticateToken, async (req, res) => {
  try {
    const [plantillas] = await pool.execute(
      'SELECT * FROM presupuestos WHERE activo = 1 ORDER BY modelo'
    );
    res.json({ ok: true, plantillas });
  } catch (error) {
    console.error('Error GET /presupuestos:', error);
    res.status(500).json({ error: 'Error al obtener plantillas' });
  }
});

// GET una plantilla específica
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const [plantillas] = await pool.execute(
      'SELECT * FROM presupuestos WHERE id = ? AND activo = 1',
      [req.params.id]
    );

    if (plantillas.length === 0) {
      return res.status(404).json({ error: 'Plantilla no encontrada' });
    }

    res.json({ ok: true, plantilla: plantillas[0] });
  } catch (error) {
    console.error('Error GET /presupuestos/:id:', error);
    res.status(500).json({ error: 'Error al obtener plantilla' });
  }
});

// POST crear plantilla (solo Owner)
router.post('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;

    if (!(await isOwner(userId))) {
      return res.status(403).json({
        error: 'Solo el Dueño puede crear plantillas de presupuesto'
      });
    }

    const {
      modelo,
      imagen_url,
      precio_contado,
      especificaciones_tecnicas,
      planes_cuotas,
      bonificaciones,
      anticipo
    } = req.body;

    if (!modelo) {
      return res.status(400).json({ error: 'El modelo es obligatorio' });
    }

    const [result] = await pool.execute(
      `INSERT INTO presupuestos
       (modelo, marca, imagen_url, precio_contado, especificaciones_tecnicas,
        planes_cuotas, bonificaciones, anticipo, activo, created_by, created_at)
       VALUES (?, 'fiat', ?, ?, ?, ?, ?, ?, 1, ?, NOW())`,
      [
        modelo,
        imagen_url || null,
        precio_contado || null,
        especificaciones_tecnicas || null,
        planes_cuotas ? JSON.stringify(planes_cuotas) : null,
        bonificaciones || null,
        anticipo || null,
        userId
      ]
    );

    const [newPlantilla] = await pool.execute(
      'SELECT * FROM presupuestos WHERE id = ?',
      [result.insertId]
    );

    res.json({ ok: true, plantilla: newPlantilla[0] });
  } catch (error) {
    console.error('Error POST /presupuestos:', error);
    res.status(500).json({ error: 'Error al crear plantilla' });
  }
});

// PUT actualizar plantilla (solo Owner)
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;

    if (!(await isOwner(userId))) {
      return res.status(403).json({
        error: 'Solo el Dueño puede editar plantillas de presupuesto'
      });
    }

    const { id } = req.params;
    const updates = req.body;

    const allowedFields = [
      'modelo', 'imagen_url', 'precio_contado',
      'especificaciones_tecnicas', 'planes_cuotas', 'bonificaciones',
      'anticipo', 'activo'
    ];

    const setClause = [];
    const values = [];

    for (const [key, value] of Object.entries(updates)) {
      if (allowedFields.includes(key)) {
        if (key === 'planes_cuotas' && typeof value === 'object') {
          setClause.push(`${key} = ?`);
          values.push(JSON.stringify(value));
        } else {
          setClause.push(`${key} = ?`);
          values.push(value);
        }
      }
    }

    if (setClause.length === 0) {
      return res.status(400).json({ error: 'No hay campos para actualizar' });
    }

    values.push(id);

    await pool.execute(
      `UPDATE presupuestos SET ${setClause.join(', ')}, updated_at = NOW() WHERE id = ?`,
      values
    );

    const [updated] = await pool.execute(
      'SELECT * FROM presupuestos WHERE id = ?',
      [id]
    );

    res.json({ ok: true, plantilla: updated[0] });
  } catch (error) {
    console.error('Error PUT /presupuestos/:id:', error);
    res.status(500).json({ error: 'Error al actualizar plantilla' });
  }
});

// DELETE plantilla (solo Owner - soft delete)
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;

    if (!(await isOwner(userId))) {
      return res.status(403).json({
        error: 'Solo el Dueño puede eliminar plantillas de presupuesto'
      });
    }

    const { id } = req.params;

    await pool.execute(
      'UPDATE presupuestos SET activo = 0, updated_at = NOW() WHERE id = ?',
      [id]
    );

    res.json({ ok: true, message: 'Plantilla eliminada exitosamente' });
  } catch (error) {
    console.error('Error DELETE /presupuestos/:id:', error);
    res.status(500).json({ error: 'Error al eliminar plantilla' });
  }
});

// POST generar PDF del presupuesto CON ARCHIVOS
router.post('/generar-pdf', authenticateToken, upload.fields([
  { name: 'imagen1', maxCount: 1 },
  { name: 'imagen2', maxCount: 1 },
  { name: 'imagen3', maxCount: 1 },
  { name: 'imagenCotizador', maxCount: 1 }
]), async (req, res) => {
  const uploadedFiles = [];

  try {
    if (!generarPresupuestoPDF) {
      return res.status(501).json({ error: 'Generador de PDF no instalado en este servidor (falta services/pdfGenerator.js)' });
    }

    console.log(`User ${req.user.username || 'unknown'} (ID: ${req.user.userId || req.user.id}) accessing POST /generar-pdf`);

    const formData = req.body && req.body.data ? JSON.parse(req.body.data) : (req.body || {});

    const imagenes = [];
    if (req.files) {
      if (req.files.imagen1) {
        imagenes[0] = req.files.imagen1[0].path;
        uploadedFiles.push(req.files.imagen1[0].path);
      }
      if (req.files.imagen2) {
        imagenes[1] = req.files.imagen2[0].path;
        uploadedFiles.push(req.files.imagen2[0].path);
      }
      if (req.files.imagen3) {
        imagenes[2] = req.files.imagen3[0].path;
        uploadedFiles.push(req.files.imagen3[0].path);
      }
      if (req.files.imagenCotizador) {
        formData.imagenCotizador = req.files.imagenCotizador[0].path;
        uploadedFiles.push(req.files.imagenCotizador[0].path);
      }
    }

    formData.imagenes = imagenes;

    const { filePath, fileName } = await generarPresupuestoPDF(formData);

    res.download(filePath, fileName, (err) => {
      if (err) {
        console.error('Error sending file:', err);
      }

      fs.unlink(filePath, (unlinkErr) => {
        if (unlinkErr) {
          console.error('Error deleting PDF file:', unlinkErr);
        } else {
          console.log('PDF file deleted successfully:', fileName);
        }
      });

      uploadedFiles.forEach(file => {
        fs.unlink(file, (unlinkErr) => {
          if (unlinkErr) {
            console.error('Error deleting uploaded file:', unlinkErr);
          }
        });
      });
    });

  } catch (error) {
    console.error('Error POST /presupuestos/generar-pdf:', error);

    uploadedFiles.forEach(file => {
      fs.unlink(file, (unlinkErr) => {
        if (unlinkErr) {
          console.error('Error deleting uploaded file after error:', unlinkErr);
        }
      });
    });

    res.status(500).json({ error: 'Error al generar PDF' });
  }
});

module.exports = router;
