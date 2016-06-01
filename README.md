# Haste Service

## About
Personal fork of haste-server to include several modifications for my needs
- Updated interface to not cover/block content
- Ability to upload images/files
- Ability to store metadata along with the paste/file
- Compress pastes in datastore
- Bug fixes
 - Updated library dependencies
 - Shortcuts respond to mac command key

## Installation
### Prerequisites
 - Node: 0.10.31+
 - NPM: 1.4.24+
 - Redis: Tested with 2.8.19, presumably anything from 2.0+ works, no idea about 1.x

### Setup
 - Clone the repository for the changeset/release desired
 - Copy `config.sample.js` to `config.js` and modify per your needs.
 - Run `npm install` from the base directory
 - Ensure redis-server is running

#### Running Service (Development/Debug)
 - Run `npm start` from the base directory

#### Running Service (Production)
 - Copy one of the sample init scripts in the "init" folder to the appropriate location on your system. Adapt to suit your configuration.
  - If your distribution uses systemd, copy init/haste-server.service to /etc/systemd/system/haste-server.service. Tested to work with CentOS 7.
  - If your distribution uses sysvinit, copy init/haste-server.sysv to /etc/init.d/haste-server. Tested to work with CentOS 6.
 - Both scripts assume that haste-server is installed in /usr/local/haste-bin and a dedicated 'haste' user account is used to run the service.
