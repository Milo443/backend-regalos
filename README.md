# CEMCOP Entregas — Backend API

Backend REST desarrollado en **Express.js 5 + Node.js LTS + TypeScript + MySQL 8.0** para el **Sistema de Gestión y Entrega de Obsequios de CEMCOP**.

## Arquitectura y tecnologías

- **Framework HTTP:** Express.js `^5.1.0` (`src/app.ts`, `src/server.ts`)
- **Runtime:** Node.js LTS (`^22.22.3 || ^24.15.0 || ^26.0.0`, verificado en `v26.13.1`)
- **Lenguaje:** TypeScript `^5.8.2` (`npm run build` / `tsx watch` en desarrollo)
- **Base de datos:** MySQL 8.0 (`mysql2`), esquema relacional en `database/schema.sql` (sin comandos `SET` de sesión para compatibilidad con AWS RDS Proxy; zona horaria recomendada `America/Bogota` y charset `utf8mb4`)
- **Caché y rate limiting:** Redis (`ioredis`) opcional mediante `REDIS_URL`; si se omite en desarrollo, utiliza fallback en memoria automáticamente
- **Almacenamiento de firmas y reportes:** `STORAGE_PROVIDER=s3` (AWS S3) o `STORAGE_PROVIDER=local` (directorio local `./.local-storage` expuesto bajo `/api/v1/storage/local/:key`)
- **Colas y workers:** SQS (`SQS_REPORTS_QUEUE_URL`, `SQS_EMAIL_QUEUE_URL`) opcionales; en desarrollo local ejecuta el procesamiento en proceso si no se configuran
- **Compatibilidad Serverless / AWS Lambda:** Handlers incluidos en `src/lambdas/` (`http-lambda.ts`, `importer-lambda.ts`, `notifier-sqs-lambda.ts`, `reports-sqs-lambda.ts`)

---

## Requisitos previos

- **Node.js LTS:** `>= 22.22.3` (`22.x`, `24.x` o `26.x`) y **npm**
- **MySQL 8.0:** servidor local o instancia accesible en `DB_HOST:DB_PORT`
- *(Opcional en desarrollo)* Redis local o Upstash TLS, cuenta SMTP Office 365 y credenciales AWS S3/SQS

---

## Inicialización paso a paso en local

### Paso 1: Clonar el repositorio e instalar dependencias

```bash
git clone https://github.com/Milo443/backend-regalos.git
cd backend-regalos
npm install
```

### Paso 2: Inicializar la base de datos en MySQL 8.0

Ejecuta el script `database/schema.sql` para crear la base de datos `cemcop_entregas_db`, sus tablas e índices, y cargar los datos semilla iniciales:

```bash
mysql -u root -p < database/schema.sql
```

> Si usas PowerShell en Windows y el operador `<` no redirige el archivo en tu sesión:
> ```powershell
> Get-Content .\database\schema.sql -Raw | mysql -u root -p
> ```

**Semillas iniciales creadas por `database/schema.sql`:**
- **Sede inicial (`id = 1`):** código `CLO-01`, nombre `Cali Principal`, ciudad `Cali`, `activa = 1`.
- **Usuario `SUPER_ADMIN` inicial (`id = 1`):**
  - **Usuario (`username`):** `admin`
  - **Contraseña temporal:** `secret`
  - **Cambio obligatorio (`debe_cambiar_clave = 1`):** en el primer inicio de sesión la API / frontend exigirá actualizar esta clave antes de operar el sistema.

### Paso 3: Configurar variables de entorno (`.env`)

Copia la plantilla `.env.example` a `.env`:

**Linux / macOS / Git Bash:**
```bash
cp .env.example .env
```

**Windows PowerShell:**
```powershell
Copy-Item .env.example .env
```

Edita `.env` y ajusta las credenciales de tu MySQL local (`DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME=cemcop_entregas_db`) y secretos JWT:

```env
NODE_ENV=development
PORT=3000
CORS_ORIGIN=http://localhost:4200

DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=tu_password_mysql
DB_NAME=cemcop_entregas_db
DB_CONNECTION_LIMIT=10

REDIS_URL=

JWT_ACCESS_SECRET=cambia_este_secreto_access_minimo_32_caracteres_seguros
JWT_REFRESH_SECRET=cambia_este_secreto_refresh_minimo_32_caracteres_seguros
JWT_ACCESS_TTL_SECONDS=900
JWT_REFRESH_TTL_SECONDS=43200

STORAGE_PROVIDER=local
LOCAL_STORAGE_DIR=./.local-storage
```

> **Nota:** Para desarrollo local, mantener `REDIS_URL=`, `SQS_REPORTS_QUEUE_URL=`, `SQS_EMAIL_QUEUE_URL=` vacíos y `STORAGE_PROVIDER=local` permite levantar todo el backend únicamente con Node.js y MySQL 8.0.

### Paso 4: Ejecutar el servidor

**Modo desarrollo (recarga automática con `tsx watch`):**
```bash
npm run dev
```
El servidor quedará escuchando por defecto en `http://localhost:3000`.

**Modo compilado / producción:**
```bash
npm run build
npm start
```

### Paso 5: Verificar que la API y la base de datos estén operativas

Consulta el endpoint de salud:

```bash
curl http://localhost:3000/api/v1/health
```

Respuesta esperada cuando MySQL y el servicio de caché responden (`HTTP 200`):

```json
{
  "status": "ok",
  "services": {
    "mysql": "up",
    "redis": "up"
  }
}
```

*(Si MySQL no está encendido o las credenciales en `.env` no son válidas, responderá `HTTP 503` con `"status": "degraded"` y `"mysql": "down"`).*

---

## Documentación interactiva Swagger (OpenAPI 3.0)

El backend expone documentación interactiva Swagger UI y especificación OpenAPI `3.0.3` para probar todos los endpoints directamente desde el navegador:

- **Swagger UI principal:** `http://localhost:3000/api-docs`
- **Swagger UI (prefijo API v1):** `http://localhost:3000/api/v1/docs`
- **Especificación JSON OpenAPI:** `http://localhost:3000/api/v1/openapi.json` (también disponible en `http://localhost:3000/api-docs.json`)

> Para probar rutas protegidas en Swagger UI, ejecuta primero `POST /auth/login` (por ejemplo `admin` / `secret`), copia `access_token` y pégalo en el botón **Authorize** (`bearerAuth`).

---

## Scripts disponibles

| Script | Comando | Descripción |
| :--- | :--- | :--- |
| `dev` | `npm run dev` | Levanta el servidor en modo desarrollo con `tsx watch src/server.ts`. |
| `typecheck` | `npm run typecheck` | Valida tipos TypeScript sin emitir archivos (`tsc --noEmit`). |
| `build` | `npm run build` | Compila TypeScript en la carpeta `dist/`. |
| `start` | `npm start` | Ejecuta el servidor compilado (`node dist/server.js`). |

---

## Endpoints principales (`/api/v1`)

| Prefijo | Descripción |
| :--- | :--- |
| `/api/v1/health` | Estado del servicio, conexión MySQL y Redis/caché |
| `/api/v1/auth` | Autenticación JWT, refresh cookie (`cemcop_refresh_token`) y cambio de clave inicial |
| `/api/v1/sedes` | Gestión de sedes físicas de entrega |
| `/api/v1/usuarios` | Gestión de usuarios y roles (`SUPER_ADMIN`, `ADMINISTRADOR`, `REPARTIDOR`) |
| `/api/v1/actividades` | Campañas / actividades de entrega y control de inventario |
| `/api/v1/importaciones` | Carga masiva de asociados desde Excel (`exceljs`) |
| `/api/v1/asociados` | Padrón e historial de asociados |
| `/api/v1/entregas` | Registro de entregas con firma e idempotencia (`sharp` / `local` o `s3`) |
| `/api/v1` | Anulaciones de entregas (`anulacionesRouter`) |
| `/api/v1/reportes` | Generación y descarga de reportes |
| `/api/v1/auditoria` | Consulta de trazabilidad y logs forenses |
