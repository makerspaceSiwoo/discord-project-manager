const origin = new URL(process.env.APP_ORIGIN).origin;
let healthy = false;
for (let attempt = 1; attempt <= 6; attempt++) {
  try {
    const response = await fetch(origin + '/api/health', {
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
    });
    const body = await response.json();
    if (response.ok && body.ok === true && body.service === '플젝하는 연수리') {
      healthy = true;
      break;
    }
  } catch {
    // DNS/TLS propagation after a first deployment may take a short time.
  }
  if (attempt < 6) await new Promise((resolve) => setTimeout(resolve, 5000));
}
if (!healthy) {
  console.error('HTTP health check failed. Check the Worker URL and deployment in Cloudflare.');
  process.exitCode = 1;
} else {
  console.log(
    'HTTP health check passed. Discord/Notion integration requires separate verification.',
  );
}
