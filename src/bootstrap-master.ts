import { appointMaster } from './auth';
import { closeDb } from './database';

const username = process.argv.slice(2).find((arg) => arg.trim() !== '' && !arg.startsWith('-'));

if (!username) {
  console.error('usage: bootstrap-master <username>');
  console.error('Set HERMES_BOOTSTRAP_PASSWORD when the username is new.');
  process.exit(1);
}

appointMaster(username, process.env.HERMES_BOOTSTRAP_PASSWORD)
  .then((user) => {
    console.log(`master is ${user.username}`);
    closeDb();
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'could not appoint master');
    closeDb();
    process.exit(1);
  });
