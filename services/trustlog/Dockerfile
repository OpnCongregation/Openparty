FROM golang:1.22 AS build
WORKDIR /src
COPY go.mod ./
COPY *.go ./
# Reproducible: no cgo, stripped, no build paths or VCS stamps
RUN CGO_ENABLED=0 go build -trimpath -buildvcs=false -ldflags="-s -w -buildid=" -o /trustlog .

RUN mkdir /data

FROM gcr.io/distroless/static:nonroot
COPY --from=build /trustlog /trustlog
COPY --from=build --chown=65532:65532 /data /data
ENTRYPOINT ["/trustlog"]
