FROM node:8
RUN mkdir -p /usr/src/app
RUN echo deb http://http.debian.net/debian jessie-backports main >> /etc/apt/sources.list.d/backports.list && \
    apt-get -y update && \
    apt-get install -y ffmpeg && \
    rm -rf /var/lib/apt/lists/*
RUN apt-get -y update && \
    apt-get install -y sox && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /usr/src/app
COPY package.json /usr/src/app/
COPY yarn.lock /usr/src/app/
RUN yarn && yarn cache clean
COPY . /usr/src/app
CMD yarn start
