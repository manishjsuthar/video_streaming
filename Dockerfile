# Use Ubuntu as the development image
FROM node:22-bullseye

# Update package list and install necessary packages
RUN apt-get update && \
    apt-get install -y build-essential python3 python3-pip net-tools iputils-ping iproute2 curl


# Set the working directory
WORKDIR /usr/src/app

COPY package*.json ./

# Install application dependencies
RUN npm install

COPY . .

# Expose the necessary ports
EXPOSE 4200
EXPOSE 2000-2020
# EXPOSE 10000-10100

# Command to run your application
CMD ["node", "index.js"]
