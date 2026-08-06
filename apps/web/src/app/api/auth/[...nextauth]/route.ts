import NextAuth from "next-auth"
import CredentialsProvider from "next-auth/providers/credentials"

const nextAuthSecret = process.env.NEXTAUTH_SECRET || "development-fallback-secret-key-12345";

const handler = NextAuth({
  providers: [
    CredentialsProvider({
      name: 'Magic Link',
      credentials: {
        token: { label: "Token", type: "text", placeholder: "Magic Link Token" }
      },
      async authorize(credentials) {
        if (!credentials?.token) return null;

        try {
          const res = await fetch(`http://localhost:3001/auth/verify?token=${encodeURIComponent(credentials.token)}`);
          if (!res.ok) return null;
          const data = await res.json();

          if (data.success && data.token && data.user) {
            return { id: data.user.id, name: data.user.email, email: data.user.email, accessToken: data.token };
          }
        } catch (e) {
          console.error('API Verification error', e);
        }
        return null;
      }
    })
  ],
  pages: {
    signIn: '/auth/signin',
  },
  session: {
    strategy: "jwt",
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.accessToken = (user as any).accessToken;
        token.id = user.id;
      }
      return token;
    },
    async session({ session, token }) {
      if (token) {
        (session as any).accessToken = token.accessToken;
        if (session.user) {
          (session.user as any).id = token.id as string;
        }
      }
      return session;
    }
  },
  secret: nextAuthSecret,
})



export { handler as GET, handler as POST }
