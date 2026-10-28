# syntax=docker/dockerfile:1
# Imaginea de backup FINET (serviciul compose `finet-backup`, ADR 0009, docs/BACKUP.md):
# restic + clientul PostgreSQL 17 (pg_dump, pg_restore, psql) + openssh-client (destinație SFTP).
# Se construiește în CI (workflow-ul `images`, ținta `backup`), NU pe host:
#   docker build -f ops/backup/Dockerfile --target backup -t finet:backup .
# Fără secrete în imagine: parola restic, adresa repository-ului, cheile S3/SFTP și conexiunea
# la bază vin la rulare, ca fișiere (/run/secrets/*).
#
# Versiuni: Alpine 3.22 are restic 0.18 (are `backup --stdin-from-command`, din 0.17) și
# postgresql17-client 17.x. pg_dump trebuie să fie cel puțin de versiunea majoră a serverului
# (ops/postgres/VERSION = 17); la upgrade-ul Supabase la 18 se schimbă și pachetul de aici
# (docs/INFRA.md, „Upgrade PostgreSQL”). Pachetele sunt fixate pe versiunea minoră (`~`):
# revizia exactă dispare din depozitul Alpine la fiecare actualizare de securitate.

ARG ALPINE_IMAGE=alpine:3.22.7

FROM ${ALPINE_IMAGE} AS backup
# uid 1000 = proprietarul /srv/finet/storage (utilizatorul `node` din imaginile FINET); ssh cere
# o intrare în /etc/passwd pentru uid-ul curent.
RUN apk add --no-cache "restic~0.18" "postgresql17-client~17" openssh-client-default tzdata ca-certificates \
  && addgroup -g 1000 finet && adduser -D -u 1000 -G finet -h /tmp/home -s /sbin/nologin finet \
  && restic version && pg_dump --version

COPY --chmod=0555 ops/backup/lib.sh ops/backup/backup.sh ops/backup/restore.sh ops/backup/entrypoint.sh /opt/finet-backup/

ENV TZ=Europe/Bucharest \
    HOME=/tmp/home \
    RESTIC_CACHE_DIR=/tmp/restic-cache \
    FINET_BACKUP_HOST=finet

USER 1000:1000
WORKDIR /tmp
HEALTHCHECK NONE
ENTRYPOINT ["/opt/finet-backup/entrypoint.sh"]
CMD ["backup"]
