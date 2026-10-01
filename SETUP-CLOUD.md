# Atlas cloud accounts — go-live checklist

Do these **before** merging this branch into `main`. Production
(atlasfinserv.vercel.app) deploys from `main`. If the new app goes live before
the backend is ready, users see "Can't reach Atlas". Their data stays on their
phone and nothing is lost, but they can't use the app until setup is done.

## 1. Restore the Supabase project
Supabase dashboard → **Atlas** project → **Restore project**. Wait until it shows as healthy.

## 2. Apply the database migration
Run `supabase/migrations/20261001000000_cloud_accounts.sql`. Either paste it into
**SQL Editor** and run it, or use `supabase db push`. It is safe to run more than once.

What it does:
- adds `profiles` (pending / approved / rejected). `rizwanmoulavi@gmail.com` is approved automatically.
- adds `signup_tokens`, the secret approval link for each account. Only the server can read it.
- signs up every existing account as **pending**.
- `atlas_state` (everyone's data) can only be read or written by **approved** accounts.

## 3. Resend (sends the approval emails)
1. Sign up at resend.com **with atlasstudiopvtltd@gmail.com**. On the free plan,
   emails sent from `onboarding@resend.dev` can only go to the account owner's address.
2. Create an API key.
3. Supabase → **Edge Functions → Secrets** → add `RESEND_API_KEY` = that key.
   Optional: `ADMIN_EMAIL` (default `atlasstudiopvtltd@gmail.com`) and
   `APP_URL` (default `https://atlasfinserv.vercel.app`).

## 4. Deploy the two functions
```
supabase functions deploy notify-signup
supabase functions deploy approve-signup --no-verify-jwt
```
`approve-signup` must have **JWT verification off**. The secret token in the email link is what protects it.

## 5. Auth settings (Supabase → Authentication)
- **Custom SMTP (required).** Without it, Supabase only sends auth emails to
  your own team members, about 2 an hour, so users never get confirmation or
  reset emails. The templates also stay locked.
  Use the atlasstudiopvtltd@gmail.com Gmail account:
  1. Turn on 2-Step Verification for that Google account, then create an
     **App password** at myaccount.google.com/apppasswords.
  2. **Emails → SMTP Settings → Enable custom SMTP**:
     sender email `atlasstudiopvtltd@gmail.com`, sender name `Atlas`,
     host `smtp.gmail.com`, port `465`, username `atlasstudiopvtltd@gmail.com`,
     password = the 16-character app password.
  3. **Rate Limits**: raise "emails sent per hour" (e.g. 30).
- **URL Configuration → Site URL**: `https://atlasfinserv.vercel.app`. Under
  Redirect URLs, add `https://atlasfinserv.vercel.app/**` and `https://*-rizwan3.vercel.app/**`.
- **Emails → Reset Password** template (editable once SMTP is on). Replace the body with:
  ```html
  <h2>Reset your Atlas password</h2>
  <p>Your code is:</p>
  <p style="font-size:28px;letter-spacing:4px"><b>{{ .Token }}</b></p>
  <p>Enter it in Atlas with your new password. It expires in 1 hour.</p>
  ```
  If you keep the default template (a button), reset still works: the button
  opens Atlas and asks for the new password there.
- **Confirm email**: either setting works. With it on, new users tap a link in their email before signing in.

## 6. Test on the Vercel preview, then merge
1. Sign in as yourself. You're approved automatically, so you'll get the restore step.
2. Create a test account and check that the approval email reaches atlasstudiopvtltd@gmail.com.
3. Approve it, sign in, and restore.
4. Try "Forgot password?".

Then merge into `main`.
