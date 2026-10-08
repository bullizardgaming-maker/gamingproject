# Postgres 16 with WAL-G for continuous archiving (point-in-time recovery).
FROM postgres:16
ARG WALG_VERSION=v3.0.5
ADD https://github.com/wal-g/wal-g/releases/download/${WALG_VERSION}/wal-g-pg-ubuntu-22.04-amd64 /usr/local/bin/wal-g
RUN chmod 0755 /usr/local/bin/wal-g
COPY postgresql.backup.conf /etc/postgresql/conf.d/backup.conf
COPY 10-replication.sh /docker-entrypoint-initdb.d/10-replication.sh
CMD ["postgres", "-c", "include_dir=/etc/postgresql/conf.d"]
