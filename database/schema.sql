-- Creación de la base de datos oficial CEMCOP Entregas
CREATE DATABASE IF NOT EXISTS cemcop_entregas_db
CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE cemcop_entregas_db;

-- 1. Sedes físicas de entrega
CREATE TABLE IF NOT EXISTS sedes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    codigo VARCHAR(20) NOT NULL UNIQUE,
    nombre VARCHAR(120) NOT NULL,
    direccion VARCHAR(250) NULL,
    ciudad VARCHAR(80) NOT NULL,
    activa TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- 2. Usuarios del sistema
CREATE TABLE IF NOT EXISTS usuarios (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(60) NOT NULL UNIQUE,
    nombre VARCHAR(150) NOT NULL,
    email VARCHAR(120) NULL,
    password_hash VARCHAR(255) NOT NULL,
    rol ENUM('SUPER_ADMIN', 'ADMINISTRADOR', 'REPARTIDOR') NOT NULL,
    debe_cambiar_clave TINYINT(1) NOT NULL DEFAULT 1,
    sede_id INT NULL,
    activo TINYINT(1) NOT NULL DEFAULT 1,
    ultimo_acceso DATETIME NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_usuarios_sede FOREIGN KEY (sede_id) REFERENCES sedes(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- 3. Actividades / Campañas de entrega
CREATE TABLE IF NOT EXISTS actividades (
    id INT AUTO_INCREMENT PRIMARY KEY,
    titulo VARCHAR(180) NOT NULL,
    cantidad_comprada INT NOT NULL,
    saldo_disponible INT NOT NULL,
    total_entregados INT NOT NULL DEFAULT 0,
    estado ENUM('BORRADOR', 'ACTIVA', 'CERRADA') NOT NULL DEFAULT 'BORRADOR',
    activa_lock TINYINT GENERATED ALWAYS AS (IF(estado = 'ACTIVA', 1, NULL)) STORED,
    fecha_inicio DATE NULL,
    fecha_fin DATE NULL,
    creado_por INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_actividades_usuario FOREIGN KEY (creado_por) REFERENCES usuarios(id),
    CONSTRAINT chk_saldo_positivo CHECK (saldo_disponible >= 0),
    CONSTRAINT chk_entregados_valido CHECK (total_entregados >= 0),
    CONSTRAINT chk_inventario_coherente CHECK (total_entregados <= cantidad_comprada),
    UNIQUE KEY uq_unica_actividad_activa (activa_lock)
) ENGINE=InnoDB;

-- 4. Padrón de Asociados
CREATE TABLE IF NOT EXISTS asociados (
    id INT AUTO_INCREMENT PRIMARY KEY,
    cedula VARCHAR(25) NOT NULL UNIQUE,
    nombre_completo VARCHAR(250) NOT NULL,
    email VARCHAR(120) NULL,
    direccion VARCHAR(255) NULL,
    fecha_ult_act DATE NULL,
    observacion TEXT NULL,
    activo TINYINT(1) NOT NULL DEFAULT 1,
    creado_por INT NULL,
    actualizado_por INT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_asociados_creador FOREIGN KEY (creado_por) REFERENCES usuarios(id),
    CONSTRAINT fk_asociados_actualizador FOREIGN KEY (actualizado_por) REFERENCES usuarios(id),
    INDEX idx_asociados_cedula (cedula),
    INDEX idx_asociados_nombre (nombre_completo),
    FULLTEXT INDEX ft_asociados_nombre (nombre_completo)
) ENGINE=InnoDB;

-- 4b. Censo de Asociados habilitados por Campaña
CREATE TABLE IF NOT EXISTS actividad_asociados (
    actividad_id INT NOT NULL,
    asociado_id INT NOT NULL,
    habilitado TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (actividad_id, asociado_id),
    CONSTRAINT fk_act_asoc_actividad FOREIGN KEY (actividad_id) REFERENCES actividades(id),
    CONSTRAINT fk_act_asoc_asociado FOREIGN KEY (asociado_id) REFERENCES asociados(id),
    INDEX idx_act_asoc_habilitado (actividad_id, habilitado)
) ENGINE=InnoDB;

-- 5. Importaciones masivas desde Excel
CREATE TABLE IF NOT EXISTS importaciones_excel (
    id INT AUTO_INCREMENT PRIMARY KEY,
    actividad_id INT NOT NULL,
    usuario_id INT NOT NULL,
    nombre_archivo VARCHAR(255) NOT NULL,
    total_filas INT NOT NULL DEFAULT 0,
    total_nuevos INT NOT NULL DEFAULT 0,
    total_actualizados INT NOT NULL DEFAULT 0,
    estado ENUM('PROCESANDO', 'EXITOSO', 'FALLIDO', 'CON_ERRORES') NOT NULL DEFAULT 'PROCESANDO',
    log_observaciones TEXT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_import_actividad FOREIGN KEY (actividad_id) REFERENCES actividades(id),
    CONSTRAINT fk_import_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
) ENGINE=InnoDB;

-- 6. Trazabilidad de cambios en asociados (Campo por Campo)
CREATE TABLE IF NOT EXISTS asociados_auditoria (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    asociado_id INT NOT NULL,
    usuario_id INT NOT NULL,
    rol_usuario ENUM('SUPER_ADMIN', 'ADMINISTRADOR') NOT NULL,
    accion ENUM('CREACION', 'MODIF_PARCIAL', 'EDICION_MAESTRA') NOT NULL,
    campo_modificado VARCHAR(60) NOT NULL,
    valor_anterior LONGTEXT NULL,
    valor_nuevo LONGTEXT NULL,
    motivo TEXT NULL,
    ip_origen VARCHAR(45) NOT NULL,
    fecha_cambio TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_audit_asociado FOREIGN KEY (asociado_id) REFERENCES asociados(id) ON DELETE RESTRICT,
    CONSTRAINT fk_audit_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios(id),
    INDEX idx_audit_asociado_fecha (asociado_id, fecha_cambio DESC)
) ENGINE=InnoDB;

-- 7. Entregas de obsequios y firmas
CREATE TABLE IF NOT EXISTS entregas (
    id INT AUTO_INCREMENT PRIMARY KEY,
    actividad_id INT NOT NULL,
    asociado_id INT NOT NULL,
    repartidor_id INT NOT NULL,
    sede_id INT NOT NULL,
    cedula_historica VARCHAR(25) NOT NULL,
    nombre_historico VARCHAR(250) NOT NULL,
    estado ENUM('ENTREGADO', 'ANULADO') NOT NULL DEFAULT 'ENTREGADO',
    activo_lock TINYINT GENERATED ALWAYS AS (IF(estado = 'ENTREGADO', 1, NULL)) STORED,
    fecha_entrega DATE NOT NULL,
    hora_entrega TIME NOT NULL,
    otra_informacion TEXT NULL,
    firma_key VARCHAR(500) NOT NULL,
    firma_thumb_key VARCHAR(500) NULL,
    idempotency_key VARCHAR(64) NULL UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_entregas_actividad FOREIGN KEY (actividad_id) REFERENCES actividades(id),
    CONSTRAINT fk_entregas_asociado FOREIGN KEY (asociado_id) REFERENCES asociados(id),
    CONSTRAINT fk_entregas_repartidor FOREIGN KEY (repartidor_id) REFERENCES usuarios(id),
    CONSTRAINT fk_entregas_sede FOREIGN KEY (sede_id) REFERENCES sedes(id),
    UNIQUE KEY uq_entrega_activa (actividad_id, asociado_id, activo_lock),
    INDEX idx_entregas_asoc_act_est (asociado_id, actividad_id, estado),
    INDEX idx_entregas_fecha_act (actividad_id, fecha_entrega, estado)
) ENGINE=InnoDB;

-- 8. Anulaciones de entregas
CREATE TABLE IF NOT EXISTS anulaciones (
    id INT AUTO_INCREMENT PRIMARY KEY,
    entrega_id INT NOT NULL UNIQUE,
    asociado_id INT NOT NULL,
    admin_id INT NOT NULL,
    motivo TEXT NOT NULL,
    fecha_anulacion DATETIME NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_anulacion_entrega FOREIGN KEY (entrega_id) REFERENCES entregas(id),
    CONSTRAINT fk_anulacion_asociado FOREIGN KEY (asociado_id) REFERENCES asociados(id),
    CONSTRAINT fk_anulacion_admin FOREIGN KEY (admin_id) REFERENCES usuarios(id)
) ENGINE=InnoDB;

-- 9. Auditoría general y seguridad
CREATE TABLE IF NOT EXISTS auditoria_logs (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    usuario_id INT NULL,
    accion VARCHAR(80) NOT NULL,
    tabla_afectada VARCHAR(60) NULL,
    registro_id INT NULL,
    detalle_operacion TEXT NULL,
    ip_origen VARCHAR(45) NOT NULL,
    user_agent VARCHAR(255) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_logs_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE SET NULL,
    INDEX idx_logs_accion_fecha (accion, created_at DESC)
) ENGINE=InnoDB;

-- Semillas iniciales
INSERT IGNORE INTO sedes (id, codigo, nombre, direccion, ciudad, activa)
VALUES (1, 'CLO-01', 'Cali Principal', 'Sede Principal CEMCOP', 'Cali', 1);

-- Usuario SUPER_ADMIN inicial (debe_cambiar_clave = 1; actualizar hash bcryptjs antes de producción)
INSERT IGNORE INTO usuarios (id, username, nombre, email, password_hash, rol, debe_cambiar_clave, sede_id, activo)
VALUES (
    1,
    'admin',
    'Super Administrador CEMCOP',
    'admin@cemcop.net',
    '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy',
    'SUPER_ADMIN',
    1,
    1,
    1
);
