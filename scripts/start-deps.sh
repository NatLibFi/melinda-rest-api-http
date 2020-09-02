#!/bin/sh
docker kill rest-api-db
docker kill rest-api-mq

docker run --rm -d -p 5672:5672 --name rest-api-mq rabbitmq:3
docker run --rm -d -p 27017:27017 --name rest-api-db mongo:4
# RabbitMQ is slow to start
sleep 10
