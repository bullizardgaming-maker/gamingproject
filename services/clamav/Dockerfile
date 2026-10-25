# ClamAV for upload scanning (render.production.yaml, docker-compose.yml), with limits that fit proof videos.
FROM clamav/clamav:stable
COPY clamd-limits.conf /tmp/clamd-limits.conf
# Drop any existing (or commented-out) setting of these keys, then append ours, so each appears once.
RUN sed -i -E '/^#?[[:space:]]*(StreamMaxLength|MaxScanSize|MaxFileSize|ReadTimeout|CommandReadTimeout)[[:space:]]/d' /etc/clamav/clamd.conf \
 && cat /tmp/clamd-limits.conf >> /etc/clamav/clamd.conf \
 && rm /tmp/clamd-limits.conf
