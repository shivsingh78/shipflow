# A stand-in for a user's VPS: OpenSSH + nginx, with a dedicated non-root
# "deploy" user. Used only by the end-to-end tests.
FROM alpine:3

RUN apk add --no-cache openssh-server openssh-keygen coreutils nginx \
 && adduser -D -s /bin/sh deploy \
 && sed -i 's/^deploy:!/deploy:*/' /etc/shadow \
 && mkdir -p /srv/site /srv/site2 /srv/site3 \
 && chown deploy:deploy /srv/site /srv/site2 /srv/site3 \
 && printf 'PasswordAuthentication no\nPermitRootLogin no\nAllowUsers deploy\n' >> /etc/ssh/sshd_config

COPY nginx.conf /etc/nginx/http.d/default.conf
COPY entrypoint.sh /entrypoint.sh

EXPOSE 22 8081 8082 8083
ENTRYPOINT ["sh", "/entrypoint.sh"]
