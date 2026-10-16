# Build the tiny TypeScript bridge before building this image:
# pnpm --filter @openwork/documents build:collabora-theme
FROM collabora/code:25.04.6.2.1
USER root
COPY dist/branding.js /tmp/openwork-branding.js
COPY branding.css /tmp/openwork-branding.css
# Preserve the engine's notices, About screen, and original branding source.
# Content-address our assets: the engine otherwise caches branding under its own version.
RUN theme_version="$(cat /tmp/openwork-branding.js /tmp/openwork-branding.css | sha256sum | cut -c1-12)" \
    && mv /tmp/openwork-branding.js /usr/share/coolwsd/browser/dist/openwork-$theme_version.js \
    && mv /tmp/openwork-branding.css /usr/share/coolwsd/browser/dist/openwork-$theme_version.css \
    && sed -i -e "s|<!--%BRANDING_JS%-->|<!--%BRANDING_JS%--><script src=\"%SERVICE_ROOT%/browser/%VERSION%/openwork-$theme_version.js\"></script>|" \
        -e "s|<!--%BRANDING_CSS%-->|<!--%BRANDING_CSS%--><link rel=\"stylesheet\" href=\"%SERVICE_ROOT%/browser/%VERSION%/openwork-$theme_version.css\" />|" \
        /usr/share/coolwsd/browser/dist/cool.html \
    && test -s /usr/share/coolwsd/browser/dist/openwork-$theme_version.js
USER cool
