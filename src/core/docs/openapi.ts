export const openApiDocument = {
  openapi: '3.0.3',
  info: {
    title: 'CEMCOP Entregas API',
    version: '1.0.0',
    description:
      'API REST oficial del Sistema de Gestión y Entrega de Obsequios de CEMCOP (Express.js 5 + MySQL 8.0 + S3/Local + SQS/In-Process).',
  },
  servers: [
    {
      url: '/api/v1',
      description: 'API v1 (servidor actual)',
    },
  ],
  tags: [
    { name: 'Health', description: 'Estado del servidor, MySQL y Redis/caché' },
    { name: 'Autenticación', description: 'Login JWT, refresh por cookie HttpOnly y cambio de clave' },
    { name: 'Sedes', description: 'Gestión de sedes físicas de entrega' },
    { name: 'Usuarios', description: 'Administración de usuarios y roles (SUPER_ADMIN)' },
    { name: 'Actividades', description: 'Campañas de entrega, inventario y cierre irrevocable' },
    { name: 'Importaciones', description: 'Carga masiva de asociados desde Excel (.xlsx)' },
    { name: 'Asociados', description: 'Búsqueda rápida, padrón, edición maestra y auditoría' },
    { name: 'Entregas', description: 'Registro atómico con firma digital, idempotencia y turno' },
    { name: 'Anulaciones', description: 'Anulación de entregas con reversión atómica de saldo' },
    { name: 'Reportes', description: 'Control diario y generación asíncrona de reportes Excel' },
    { name: 'Auditoría', description: 'Bitácora forense global (SUPER_ADMIN)' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Token de acceso JWT obtenido en POST /auth/login o POST /auth/refresh',
      },
      refreshCookie: {
        type: 'apiKey',
        in: 'cookie',
        name: 'cemcop_refresh_token',
        description: 'Cookie HttpOnly emitida al iniciar sesión o refrescar el token',
      },
    },
    schemas: {
      ErrorResponse: {
        type: 'object',
        properties: {
          error: {
            type: 'object',
            properties: {
              code: { type: 'string', example: 'VALIDATION_ERROR' },
              message: { type: 'string', example: 'Descripción del error.' },
              details: { type: 'object', additionalProperties: true },
            },
          },
        },
      },
    },
  },
  paths: {
    '/health': {
      get: {
        tags: ['Health'],
        summary: 'Verificar salud de API, MySQL y Redis/caché',
        responses: {
          '200': { description: 'Servicios operativos (status: ok)' },
          '503': { description: 'Servicio degradado (mysql o redis down)' },
        },
      },
    },
    '/auth/login': {
      post: {
        tags: ['Autenticación'],
        summary: 'Iniciar sesión y obtener JWT + cookie refresh HttpOnly',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['username', 'password'],
                properties: {
                  username: { type: 'string', example: 'admin' },
                  password: { type: 'string', example: 'secret' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Autenticación exitosa con access_token y datos del usuario' },
          '401': { description: 'Credenciales inválidas' },
          '403': { description: 'Sede inactiva para REPARTIDOR' },
        },
      },
    },
    '/auth/refresh': {
      post: {
        tags: ['Autenticación'],
        summary: 'Renovar access_token mediante cookie HttpOnly cemcop_refresh_token',
        security: [{ refreshCookie: [] }],
        responses: {
          '200': { description: 'Nuevo access_token emitido' },
          '401': { description: 'Sesión expirada o revocada' },
        },
      },
    },
    '/auth/logout': {
      post: {
        tags: ['Autenticación'],
        summary: 'Cerrar sesión actual y revocar tokens',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': { description: 'Sesión cerrada correctamente' },
          '401': { description: 'No autenticado' },
        },
      },
    },
    '/auth/cambiar-clave-inicial': {
      post: {
        tags: ['Autenticación'],
        summary: 'Cambio obligatorio de clave temporal en primer ingreso',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['password_actual', 'password_nueva'],
                properties: {
                  password_actual: { type: 'string', example: 'secret' },
                  password_nueva: { type: 'string', minLength: 8, example: 'Cemcop2026*' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Clave actualizada y nuevos tokens emitidos' },
          '400': { description: 'Error de validación' },
          '401': { description: 'Clave actual incorrecta' },
        },
      },
    },
    '/auth/cambiar-clave': {
      post: {
        tags: ['Autenticación'],
        summary: 'Cambio voluntario de contraseña',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['password_actual', 'password_nueva'],
                properties: {
                  password_actual: { type: 'string' },
                  password_nueva: { type: 'string', minLength: 8 },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Contraseña actualizada exitosamente' },
          '401': { description: 'Contraseña actual incorrecta' },
        },
      },
    },
    '/auth/me': {
      get: {
        tags: ['Autenticación'],
        summary: 'Consultar perfil autenticado y campaña activa actual',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': { description: 'Perfil del usuario y resumen de campaña activa' },
          '401': { description: 'No autenticado' },
        },
      },
    },
    '/sedes': {
      get: {
        tags: ['Sedes'],
        summary: 'Listar sedes de entrega (activas para operadores o todas para SUPER_ADMIN)',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'activa',
            in: 'query',
            schema: { type: 'string', enum: ['0', '1'] },
            description: 'Filtro de estado (solo SUPER_ADMIN)',
          },
        ],
        responses: { '200': { description: 'Listado de sedes' } },
      },
      post: {
        tags: ['Sedes'],
        summary: 'Crear una nueva sede física (SUPER_ADMIN)',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['codigo', 'nombre', 'ciudad'],
                properties: {
                  codigo: { type: 'string', example: 'BOG-01' },
                  nombre: { type: 'string', example: 'Sede Bogotá Norte' },
                  direccion: { type: 'string', nullable: true, example: 'Cra 15 # 93-40' },
                  ciudad: { type: 'string', example: 'Bogotá' },
                },
              },
            },
          },
        },
        responses: {
          '201': { description: 'Sede creada' },
          '409': { description: 'Código de sede ya registrado' },
        },
      },
    },
    '/sedes/{id}': {
      put: {
        tags: ['Sedes'],
        summary: 'Actualizar datos de una sede (SUPER_ADMIN)',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['nombre', 'ciudad'],
                properties: {
                  nombre: { type: 'string' },
                  direccion: { type: 'string', nullable: true },
                  ciudad: { type: 'string' },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'Sede actualizada' }, '404': { description: 'No encontrada' } },
      },
    },
    '/sedes/{id}/estado': {
      patch: {
        tags: ['Sedes'],
        summary: 'Activar o inactivar una sede (SUPER_ADMIN)',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['activa'],
                properties: { activa: { type: 'boolean' } },
              },
            },
          },
        },
        responses: { '200': { description: 'Estado actualizado' }, '404': { description: 'No encontrada' } },
      },
    },
    '/usuarios': {
      get: {
        tags: ['Usuarios'],
        summary: 'Listar usuarios del sistema con filtros y paginación (SUPER_ADMIN)',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'rol', in: 'query', schema: { type: 'string', enum: ['SUPER_ADMIN', 'ADMINISTRADOR', 'REPARTIDOR'] } },
          { name: 'sede_id', in: 'query', schema: { type: 'integer' } },
          { name: 'activo', in: 'query', schema: { type: 'string', enum: ['0', '1'] } },
          { name: 'q', in: 'query', schema: { type: 'string' } },
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } },
        ],
        responses: { '200': { description: 'Listado paginado de usuarios' } },
      },
      post: {
        tags: ['Usuarios'],
        summary: 'Crear usuario del sistema (SUPER_ADMIN)',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['username', 'nombre', 'password_temporal', 'rol'],
                properties: {
                  username: { type: 'string', example: 'repartidor1' },
                  nombre: { type: 'string', example: 'Carlos Pérez' },
                  email: { type: 'string', nullable: true, example: 'carlos@cemcop.net' },
                  password_temporal: { type: 'string', minLength: 8, example: 'Temporal2026*' },
                  rol: { type: 'string', enum: ['SUPER_ADMIN', 'ADMINISTRADOR', 'REPARTIDOR'] },
                  sede_id: { type: 'integer', nullable: true, example: 1 },
                },
              },
            },
          },
        },
        responses: {
          '201': { description: 'Usuario creado con debe_cambiar_clave=true' },
          '409': { description: 'Username duplicado' },
          '422': { description: 'Sede requerida para REPARTIDOR' },
        },
      },
    },
    '/usuarios/{id}': {
      put: {
        tags: ['Usuarios'],
        summary: 'Actualizar nombre, email, rol o sede de un usuario (SUPER_ADMIN)',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['nombre', 'rol'],
                properties: {
                  nombre: { type: 'string' },
                  email: { type: 'string', nullable: true },
                  rol: { type: 'string', enum: ['SUPER_ADMIN', 'ADMINISTRADOR', 'REPARTIDOR'] },
                  sede_id: { type: 'integer', nullable: true },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'Usuario actualizado' }, '404': { description: 'No encontrado' } },
      },
    },
    '/usuarios/{id}/estado': {
      patch: {
        tags: ['Usuarios'],
        summary: 'Habilitar o bloquear usuario (SUPER_ADMIN)',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['activo'],
                properties: { activo: { type: 'boolean' } },
              },
            },
          },
        },
        responses: { '200': { description: 'Estado actualizado' } },
      },
    },
    '/usuarios/{id}/reset-password': {
      post: {
        tags: ['Usuarios'],
        summary: 'Restablecer contraseña temporal de usuario (SUPER_ADMIN)',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['password_temporal'],
                properties: { password_temporal: { type: 'string', minLength: 8 } },
              },
            },
          },
        },
        responses: { '200': { description: 'Contraseña temporal asignada y sesiones revocadas' } },
      },
    },
    '/actividades': {
      get: {
        tags: ['Actividades'],
        summary: 'Listar todas las campañas / actividades',
        security: [{ bearerAuth: [] }],
        responses: { '200': { description: 'Listado de campañas' } },
      },
      post: {
        tags: ['Actividades'],
        summary: 'Crear campaña en estado BORRADOR',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['titulo', 'cantidad_comprada'],
                properties: {
                  titulo: { type: 'string', example: 'Obsequio Navideño 2026' },
                  cantidad_comprada: { type: 'integer', minimum: 0, example: 500 },
                  fecha_inicio: { type: 'string', nullable: true, example: '2026-12-01' },
                },
              },
            },
          },
        },
        responses: { '201': { description: 'Campaña creada' } },
      },
    },
    '/actividades/activa': {
      get: {
        tags: ['Actividades'],
        summary: 'Consultar la campaña ACTIVA con métricas de inventario y desglose por sede',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': { description: 'Resumen en tiempo real de campaña activa' },
          '404': { description: 'No existe campaña activa' },
        },
      },
    },
    '/actividades/{id}/evaluar-cobertura': {
      get: {
        tags: ['Actividades'],
        summary: 'Evaluar cobertura de stock frente al censo activo (OPTIMA, DEFICIT o SUPERAVIT)',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
          { name: 'cantidad', in: 'query', required: true, schema: { type: 'integer', minimum: 0 } },
        ],
        responses: { '200': { description: 'Resultado de evaluación de cobertura' } },
      },
    },
    '/actividades/{id}': {
      put: {
        tags: ['Actividades'],
        summary: 'Editar título, stock comprado o fecha de campaña no cerrada',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['titulo', 'cantidad_comprada'],
                properties: {
                  titulo: { type: 'string' },
                  cantidad_comprada: { type: 'integer', minimum: 0 },
                  fecha_inicio: { type: 'string', nullable: true, example: '2026-12-01' },
                  confirmar_deficit: { type: 'boolean' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Campaña actualizada' },
          '403': { description: 'Campaña cerrada (CAMPAIGN_CLOSED)' },
          '409': { description: 'Requiere confirmar déficit (DEFICIT_CONFIRMATION_REQUIRED)' },
        },
      },
    },
    '/actividades/{id}/activar': {
      patch: {
        tags: ['Actividades'],
        summary: 'Activar una campaña en estado BORRADOR (solo una ACTIVA a la vez)',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: {
          '200': { description: 'Campaña activada' },
          '409': { description: 'Ya existe otra campaña activa' },
        },
      },
    },
    '/actividades/{id}/cerrar': {
      post: {
        tags: ['Actividades'],
        summary: 'Cierre irrevocable de campaña a modo solo lectura (SUPER_ADMIN)',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['confirmacion'],
                properties: {
                  confirmacion: { type: 'string', enum: ['CERRAR_CAMPAÑA'] },
                  observacion: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Campaña cerrada irrevocablemente' },
          '409': { description: 'Importación en procesamiento' },
        },
      },
    },
    '/importaciones/presign': {
      post: {
        tags: ['Importaciones'],
        summary: 'Generar URL firmada (S3 o local-upload) para subir Excel de asociados',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['actividad_id', 'nombre_archivo'],
                properties: {
                  actividad_id: { type: 'integer' },
                  nombre_archivo: { type: 'string', example: 'censo_asociados.xlsx' },
                  content_type: {
                    type: 'string',
                    default: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                  },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'URL y campos de carga generados' } },
      },
    },
    '/importaciones/local-upload': {
      post: {
        tags: ['Importaciones'],
        summary: 'Subida binaria directa cuando STORAGE_PROVIDER=local',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'key', in: 'query', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
        },
        responses: { '204': { description: 'Archivo guardado localmente' } },
      },
    },
    '/importaciones/procesar': {
      post: {
        tags: ['Importaciones'],
        summary: 'Procesar archivo Excel cargado y sincronizar padrón + censo de campaña',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['actividad_id', 's3_key', 'nombre_archivo'],
                properties: {
                  actividad_id: { type: 'integer' },
                  s3_key: { type: 'string' },
                  nombre_archivo: { type: 'string' },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'Resumen de filas nuevas, actualizadas y errores' } },
      },
    },
    '/importaciones': {
      get: {
        tags: ['Importaciones'],
        summary: 'Listar historial de importaciones de Excel',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'actividad_id', in: 'query', schema: { type: 'integer' } },
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 10 } },
        ],
        responses: { '200': { description: 'Historial paginado de importaciones' } },
      },
    },
    '/asociados/buscar': {
      get: {
        tags: ['Asociados'],
        summary: 'Buscar asociado por cédula o nombre (>= 3 caracteres alfabéticos)',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'actividad_id', in: 'query', schema: { type: 'integer' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 10, maximum: 25 } },
        ],
        responses: { '200': { description: 'Coincidencias con estado de entrega actual' } },
      },
    },
    '/asociados/{id}': {
      get: {
        tags: ['Asociados'],
        summary: 'Consultar detalle de asociado y estado de entrega en campaña',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
          { name: 'actividad_id', in: 'query', schema: { type: 'integer' } },
        ],
        responses: { '200': { description: 'Ficha del asociado' }, '404': { description: 'No encontrado' } },
      },
      patch: {
        tags: ['Asociados'],
        summary: 'Actualización parcial de email, dirección u observación (ADMINISTRADOR / SUPER_ADMIN)',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  email: { type: 'string', nullable: true },
                  direccion: { type: 'string', nullable: true },
                  observacion: { type: 'string', nullable: true },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Asociado actualizado con trazabilidad por campo' },
          '403': { description: 'Campos maestros bloqueados para ADMINISTRADOR' },
        },
      },
    },
    '/asociados': {
      post: {
        tags: ['Asociados'],
        summary: 'Registrar manualmente un asociado en el padrón',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['cedula', 'nombre_completo'],
                properties: {
                  cedula: { type: 'string', example: '1144000111' },
                  nombre_completo: { type: 'string', example: 'María Fernanda Gómez' },
                  email: { type: 'string', nullable: true },
                  direccion: { type: 'string', nullable: true },
                  observacion: { type: 'string', nullable: true },
                  actividad_id: { type: 'integer' },
                },
              },
            },
          },
        },
        responses: { '201': { description: 'Asociado creado' }, '409': { description: 'Cédula duplicada' } },
      },
    },
    '/asociados/{id}/maestro': {
      put: {
        tags: ['Asociados'],
        summary: 'Edición maestra de cédula, nombre y estado con motivo obligatorio (SUPER_ADMIN)',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['cedula', 'nombre_completo', 'activo', 'motivo'],
                properties: {
                  cedula: { type: 'string' },
                  nombre_completo: { type: 'string' },
                  email: { type: 'string', nullable: true },
                  direccion: { type: 'string', nullable: true },
                  fecha_ult_act: { type: 'string', nullable: true, example: '2026-11-17' },
                  observacion: { type: 'string', nullable: true },
                  activo: { type: 'boolean' },
                  motivo: { type: 'string', minLength: 15 },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'Edición maestra registrada' } },
      },
    },
    '/asociados/{id}/auditoria': {
      get: {
        tags: ['Asociados'],
        summary: 'Historial campo por campo de modificaciones del asociado',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { '200': { description: 'Listado cronológico de cambios' } },
      },
    },
    '/entregas': {
      post: {
        tags: ['Entregas'],
        summary: 'Registrar entrega de obsequio con firma PNG base64 e idempotencia (REPARTIDOR)',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'X-Idempotency-Key',
            in: 'header',
            required: true,
            schema: { type: 'string', format: 'uuid' },
            description: 'UUIDv4 único por intento de entrega',
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['actividad_id', 'asociado_id', 'firma_base64'],
                properties: {
                  actividad_id: { type: 'integer' },
                  asociado_id: { type: 'integer' },
                  firma_base64: { type: 'string', description: 'Data URI o base64 PNG de la firma' },
                  otra_informacion: { type: 'string', nullable: true },
                },
              },
            },
          },
        },
        responses: {
          '201': { description: 'Entrega registrada exitosamente' },
          '409': { description: 'Ya entregado o inventario agotado' },
        },
      },
      get: {
        tags: ['Entregas'],
        summary: 'Listar entregas registradas (filtrado automático por repartidor si aplica)',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'actividad_id', in: 'query', schema: { type: 'integer' } },
          { name: 'q', in: 'query', schema: { type: 'string' } },
          { name: 'fecha', in: 'query', schema: { type: 'string', example: '2026-11-17' } },
          { name: 'sede_id', in: 'query', schema: { type: 'integer' } },
          { name: 'estado', in: 'query', schema: { type: 'string', enum: ['ENTREGADO', 'ANULADO'] } },
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 25 } },
        ],
        responses: { '200': { description: 'Listado paginado de entregas' } },
      },
    },
    '/entregas/mi-turno': {
      get: {
        tags: ['Entregas'],
        summary: 'Consultar resumen del turno del día del repartidor autenticado',
        security: [{ bearerAuth: [] }],
        responses: { '200': { description: 'Conteo diario y últimas 10 entregas del repartidor' } },
      },
    },
    '/entregas/{id}/firma': {
      get: {
        tags: ['Entregas'],
        summary: 'Obtener URL firmada temporal de visualización de firma PNG',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { '200': { description: 'URL de descarga/previsualización de la firma' } },
      },
    },
    '/entregas/{id}/anular': {
      post: {
        tags: ['Anulaciones'],
        summary: 'Anular una entrega y reintegrar inventario atómicamente (ADMINISTRADOR / SUPER_ADMIN)',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['motivo'],
                properties: {
                  motivo: { type: 'string', minLength: 15, example: 'Error en selección de asociado homónimo durante entrega.' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Entrega anulada y cupo liberado' },
          '409': { description: 'La entrega ya había sido anulada' },
        },
      },
    },
    '/anulaciones': {
      get: {
        tags: ['Anulaciones'],
        summary: 'Consultar historial de anulaciones registradas',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'actividad_id', in: 'query', schema: { type: 'integer' } },
          { name: 'q', in: 'query', schema: { type: 'string' } },
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } },
        ],
        responses: { '200': { description: 'Listado paginado de anulaciones' } },
      },
    },
    '/reportes/control-diario': {
      get: {
        tags: ['Reportes'],
        summary: 'Consultar métricas agregadas de control diario por campaña y sede',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'actividad_id', in: 'query', required: true, schema: { type: 'integer' } },
          { name: 'sede_id', in: 'query', schema: { type: 'integer' } },
        ],
        responses: { '200': { description: 'Totales diarios e histórico por sede' } },
      },
    },
    '/reportes/generar': {
      post: {
        tags: ['Reportes'],
        summary: 'Solicitar generación asíncrona de reporte Excel (.xlsx) con firmas embebidas',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['actividad_id', 'tipo'],
                properties: {
                  actividad_id: { type: 'integer' },
                  tipo: { type: 'string', enum: ['COMPLETO', 'DIARIO'] },
                  fecha: { type: 'string', example: '2026-11-17' },
                },
              },
            },
          },
        },
        responses: { '202': { description: 'Job aceptado y encolado' } },
      },
    },
    '/reportes/{job_id}': {
      get: {
        tags: ['Reportes'],
        summary: 'Consultar estado del job de reporte y obtener URL de descarga',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'job_id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Estado del job y download_url cuando estado=LISTO' },
          '404': { description: 'Job no encontrado o expirado' },
        },
      },
    },
    '/auditoria/logs': {
      get: {
        tags: ['Auditoría'],
        summary: 'Consultar bitácora forense global (SUPER_ADMIN)',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'usuario_id', in: 'query', schema: { type: 'integer' } },
          { name: 'accion', in: 'query', schema: { type: 'string' } },
          { name: 'fecha_desde', in: 'query', schema: { type: 'string', example: '2026-11-01' } },
          { name: 'fecha_hasta', in: 'query', schema: { type: 'string', example: '2026-11-30' } },
          { name: 'ip_origen', in: 'query', schema: { type: 'string' } },
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
        ],
        responses: { '200': { description: 'Registros de auditoría global' } },
      },
    },
  },
} as const;
