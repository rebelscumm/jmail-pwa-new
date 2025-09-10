<script lang="ts">
  import HybridAuthExample from '$lib/components/HybridAuthExample.svelte';
  import Button from '$lib/buttons/Button.svelte';
  
  function goToDebugPage() {
    window.location.href = '/auth-debug';
  }
</script>

<svelte:head>
  <title>Google Auth Test - JMail PWA</title>
  <meta name="description" content="Test the hybrid Google authentication system" />
</svelte:head>

<div class="auth-test-page">
  <div class="header">
    <h1>🧪 Google Authentication Test</h1>
    <p>Test the new hybrid authentication system that provides long-lasting Google authorization</p>
    <div class="nav-buttons">
      <Button variant="outlined" onclick={goToDebugPage}>
        🔍 Go to Debug Wizard
      </Button>
    </div>
  </div>

  <HybridAuthExample />

  <div class="footer">
    <p><strong>Note:</strong> This is a temporary test page. Once the authentication system is working properly, this page will be removed.</p>
  </div>
</div>

<style>
  .auth-test-page {
    min-height: 100vh;
    background-color: #fafafa;
    padding: 20px;
  }

  .header {
    text-align: center;
    margin-bottom: 30px;
    max-width: 800px;
    margin-left: auto;
    margin-right: auto;
  }

  .header h1 {
    color: #1976d2;
    margin-bottom: 10px;
  }

  .nav-buttons {
    margin-top: 20px;
  }

  .footer {
    max-width: 800px;
    margin: 40px auto;
    text-align: center;
    padding: 20px;
    background-color: #fff3cd;
    border: 1px solid #ffeaa7;
    border-radius: 4px;
    color: #856404;
  }

  @media (max-width: 768px) {
    .auth-test-page {
      padding: 10px;
    }
  }
</style>
