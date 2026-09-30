#!/bin/sh
# Allow streaming replicas (and pg_basebackup) to connect with the database password.
echo "host replication all all scram-sha-256" >> "$PGDATA/pg_hba.conf"
