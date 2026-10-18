FROM php:8.2-apache

# Extensões necessárias (curl + HTTPS)
RUN apt-get update && apt-get install -y \
    libcurl4-openssl-dev \
    ca-certificates \
    && update-ca-certificates \
    && docker-php-ext-install curl \
    && rm -rf /var/lib/apt/lists/*

# Permite .htaccess e reescrita (opcional)
RUN a2enmod rewrite

# Copia aplicação
COPY . /var/www/html/

# Entrypoint ajusta a porta do Apache para o $PORT do Render
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 80
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["apache2-foreground"]
