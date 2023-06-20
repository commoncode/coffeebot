FROM node:16-alpine

RUN mkdir -p /usr/src/app

WORKDIR /usr/src/app

COPY src/ .
RUN npm install

EXPOSE 3000
CMD node ./index.js
