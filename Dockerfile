FROM node:20-alpine

WORKDIR /app

# Copiar frontend estático (server.js lo sirve desde el directorio padre de backend/)
COPY index.html ./
COPY css/ ./css/
COPY js/ ./js/

# Copiar backend e instalar dependencias
COPY backend/package*.json ./backend/
RUN cd backend && npm install --production

# Copiar el resto del backend
COPY backend/ ./backend/

# El servidor escucha en el puerto indicado por Railway (PORT) o 3000
EXPOSE 3000

WORKDIR /app/backend
CMD ["node", "server.js"]
