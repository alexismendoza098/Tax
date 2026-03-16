FROM node:20-alpine

# Instalar dependencias del sistema (Python para sat_wrapper.py)
RUN apk add --no-cache python3 py3-pip

WORKDIR /app

# 1. Copiar e instalar dependencias del backend primero (mejor cache)
COPY backend/package*.json ./backend/
RUN cd backend && npm install --production && npm cache clean --force

# 2. Copiar todo el backend
COPY backend/ ./backend/

# 3. Copiar frontend estático (server.js lo sirve desde path.join(__dirname,'..') = /app)
COPY index.html ./
COPY css/ ./css/
COPY js/ ./js/

# Crear directorios necesarios
RUN mkdir -p ./backend/uploads ./backend/downloads ./backend/uploads/temp_flatten

# Puerto que expone el servidor
EXPOSE 3000

# Arrancar desde la carpeta del backend
WORKDIR /app/backend
CMD ["node", "server.js"]
