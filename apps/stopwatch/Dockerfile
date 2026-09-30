# Pinned to an exact patch tag verified multi-arch (linux/arm64/v8 included)
# with `docker manifest inspect` on 2026-07-30, so rebuilds are reproducible.
FROM python:3.12.12-alpine3.22

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8000 \
    STOPWATCH_DATA_PATH=/data/session.json

WORKDIR /app
COPY stopwatch.py server.py ./
COPY assets/ ./assets/

# /data is created and owned in the image so Docker initialises the named volume
# with the right ownership; the container itself runs unprivileged.
RUN addgroup -S -g 10001 stopwatch \
    && adduser -S -D -H -u 10001 -G stopwatch stopwatch \
    && mkdir -p /data \
    && chown -R stopwatch:stopwatch /app /data

USER stopwatch
EXPOSE 8000
VOLUME ["/data"]

CMD ["python", "server.py"]
