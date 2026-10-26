# A stand-in for a user's Docker host: Docker-in-Docker plus OpenSSH with a
# dedicated non-root "deploy" user in the docker group. Test-only; the
# service runs privileged (required by dockerd) and only inside the e2e network.
FROM docker:27-dind

RUN apk add --no-cache --upgrade openssh-server openssh-keygen openssh-client-common openssh-client-default \
 && (getent group docker >/dev/null || addgroup -S docker) \
 && adduser -D -s /bin/sh -G docker deploy \
 && sed -i 's/^deploy:!/deploy:*/' /etc/shadow \
 && printf 'PasswordAuthentication no\nPermitRootLogin no\nAllowUsers deploy\n' >> /etc/ssh/sshd_config

COPY entrypoint.sh /ssh-entrypoint.sh

ENV DOCKER_TLS_CERTDIR=""
EXPOSE 22 8090 8091 8092
ENTRYPOINT ["sh", "/ssh-entrypoint.sh"]
