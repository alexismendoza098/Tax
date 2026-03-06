# Sistema de Recuperación de IVA

Este proyecto es una aplicación web para la descarga, procesamiento y cálculo de impuestos desde el SAT México.

## Estructura del Proyecto

- **Frontend**: Archivos estáticos en la raíz (`index.html`, `css/`, `js/`).
- **Backend**: API Node.js/Express en la carpeta `backend/`.

## Requisitos Previos

- Node.js (v18+ recomendado)
- MySQL Server (v8.0+ o MariaDB)

## Configuración e Instalación

1. **Configurar Base de Datos**
   Asegúrate de tener MySQL corriendo. El script de configuración por defecto usa el puerto 3307 y usuario `root` con contraseña `Error404.`.
   
   Para inicializar la base de datos:
   ```bash
   cd backend
   npm run setup-db
   ```
   *Nota: Si tu configuración de MySQL es diferente, edita `package.json` o ejecuta el comando manualmente.*

2. **Instalar Dependencias del Backend**
   ```bash
   cd backend
   npm install
   ```

3. **Configurar Variables de Entorno**
   El archivo `backend/.env` ya ha sido creado con la configuración por defecto. Si necesitas cambiar credenciales de base de datos o puertos, edita este archivo.
   
   Ejemplo de `.env`:
   ```env
   DB_HOST=localhost
   DB_PORT=3307
   DB_USER=root
   DB_PASSWORD=tu_password
   DB_NAME=IVATAXRECOVERY
   JWT_SECRET=tu_secreto_seguro
   PORT=3000
   ```

## Ejecución

Para iniciar el servidor:

```bash
cd backend
npm start
```

El servidor iniciará en `http://localhost:3000`.
Abre esa URL en tu navegador para ver la aplicación.

## Características Implementadas

- **Frontend Modular**: CSS y JS separados para mejor mantenimiento.
- **Seguridad**:
  - Autenticación JWT.
  - Protección de cabeceras HTTP con `helmet`.
  - Rate Limiting para prevenir ataques de fuerza bruta.
  - Hashing de contraseñas con `bcrypt`.
- **Configuración**: Variables de entorno mediante `dotenv`.

## Desarrollo

Para ejecutar en modo desarrollo con reinicio automático:
```bash
npm run dev
```
