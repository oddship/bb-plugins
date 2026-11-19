# Minimal Dummie guest candidate. BB and project tools are installed by recipes.
FROM debian:bookworm-slim@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates passwd procps sudo util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 1000 --create-home --shell /bin/bash ubuntu \
    && echo 'ubuntu ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/ubuntu \
    && chmod 0440 /etc/sudoers.d/ubuntu
ENV PATH=/usr/local/bin:/usr/bin:/bin
USER ubuntu
WORKDIR /home/ubuntu
CMD ["/bin/bash"]
