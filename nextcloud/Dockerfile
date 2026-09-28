# Nextcloud image for Quick Start Home.
#
# Stock Nextcloud plus ffmpeg, which is what lets uploaded videos generate
# thumbnails. Image previews (including iPhone HEIC) are handled by the separate
# Imaginary container, not here.
FROM nextcloud:stable

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Create files the group can write to.
#
# Nextcloud runs as www-data; a shared folder on the host belongs to the person
# who made it. The panel already puts the container in that person's group so
# uploads are possible at all -- but with the default umask of 022 every file
# Nextcloud then creates is mode 644, owned by www-data. The owner of the folder
# is in the group and so gets r--, meaning a photo uploaded from a phone cannot
# be edited or deleted by the person whose folder it landed in.
#
# 002 makes new files 664 and new directories 775, which is what the rest of the
# folder already is. Apache sources envvars before starting, so this covers the
# processes that actually write uploads.
RUN echo 'umask 0002' >> /etc/apache2/envvars

LABEL org.opencontainers.image.title="quickstart-home-nextcloud" \
      org.opencontainers.image.source="https://github.com/Shudan10/Home"
