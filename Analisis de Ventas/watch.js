const chokidar = require('chokidar');
const { execSync } = require('child_process');

const watcher = chokidar.watch('.', {
  ignored: /(node_modules|\.git|watch\.js)/,
  persistent: true,
  ignoreInitial: true,
  awaitWriteFinish: {
    stabilityThreshold: 1000,
    pollInterval: 100
  }
});

console.log('👀 Vigilando cambios... (Ctrl+C para detener)');

watcher.on('change', (path) => hacer_commit('modificado', path));
watcher.on('add',    (path) => hacer_commit('agregado', path));
watcher.on('unlink', (path) => hacer_commit('eliminado', path));

function hacer_commit(accion, archivo) {
  console.log(`\n📝 Archivo ${accion}: ${archivo}`);
  try {
    execSync('git pull origin main --allow-unrelated-histories --no-edit'); // ← corregido
    execSync('git add .');
    execSync(`git commit -m "Auto: ${archivo} ${accion} - ${new Date().toLocaleString()}"`);
    execSync('git push origin main');
    console.log('✅ Subido a GitHub exitosamente');
  } catch (err) {
    console.log('⚠️ Error:', err.message);
  }
}