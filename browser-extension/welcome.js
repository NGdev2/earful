// The welcome page's Copy button.
const button = document.getElementById('copy');
button.addEventListener('click', async () => {
    try {
        await navigator.clipboard.writeText(document.getElementById('command').textContent);
        button.textContent = 'Copied';
    } catch {
        // Selecting the command is the fallback; it selects all on click.
        button.textContent = 'Select and copy';
    }
});
